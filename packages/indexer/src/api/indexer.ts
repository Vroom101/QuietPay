import { redactSecrets } from "../redact.js";
import { IndexDb } from "./db.js";
import { readPage } from "./chain.js";
import { normalizeScope, type Scope, type ChainReader } from "./model.js";
import { createExport } from "./export.js";
import { buildLedger, formatAmount } from "./ledger.js";

export class Indexer {
  readonly scope: Scope;
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  head: number | null = null;
  lastError: string | null = null;
  constructor(
    readonly db: IndexDb,
    readonly chain: ChainReader,
    scope: Scope,
    readonly pageSize = 1000,
    readonly maxPagesPerSync = 20,
  ) {
    this.scope = normalizeScope(scope);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)
      throw new Error("Page size must be between 1 and 1,000");
    if (!Number.isInteger(maxPagesPerSync) || maxPagesPerSync < 1)
      throw new Error("Invalid page limit");
    if (JSON.stringify(db.scope) !== JSON.stringify(this.scope))
      throw new Error("Store scope does not match indexer scope");
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.syncOnce()
      .then(
        () => {
          this.lastError = null;
        },
        (e) => {
          this.lastError = redactSecrets(String(e));
          throw e;
        },
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async syncOnce() {
    if ((await this.chain.getChainId()) !== this.scope.chainId)
      throw new Error("RPC chain ID does not match index scope");
    this.head = await this.chain.getHead();
    const floor = this.scope.deploymentBlock - 1,
      target = Math.max(floor, this.head - this.scope.confirmations);
    if (this.db.cursor > target) this.db.rollback(target);
    // A tip hash commits its entire ancestry. Sparse event/page checkpoints suffice for rollback.
    if (this.db.cursor >= this.scope.deploymentBlock) {
      const canonical = await this.chain.getBlock(this.db.cursor);
      if (
        canonical.hash.toLowerCase() !==
        this.db.block(this.db.cursor)?.hash.toLowerCase()
      ) {
        let ancestor = floor;
        for (const b of this.db.checkpoints()) {
          if (
            (await this.chain.getBlock(b.number)).hash.toLowerCase() ===
            b.hash.toLowerCase()
          ) {
            ancestor = b.number;
            break;
          }
        }
        this.db.rollback(ancestor);
      }
    }
    for (
      let pages = 0;
      this.db.cursor < target && pages < this.maxPagesPerSync;
      pages++
    ) {
      const previous = this.db.cursor,
        from = previous + 1,
        to = Math.min(target, from + this.pageSize - 1);
      const page = await readPage(this.chain, from, to);
      if (
        previous >= this.scope.deploymentBlock &&
        (await this.chain.getBlock(previous)).hash.toLowerCase() !==
          this.db.block(previous)?.hash.toLowerCase()
      )
        throw new Error("Reorg crossed the page anchor; retry sync");
      this.db.commit(to, page);
    }
  }
  async snapshot(to?: number) {
    await this.sync();
    const cursor = this.db.cursor,
      end = to ?? cursor;
    if (end < this.scope.deploymentBlock || end > cursor)
      throw new Error("Requested range is not fully indexed and confirmed");
    const anchor = await this.chain.getBlock(cursor);
    if (anchor.hash.toLowerCase() !== this.db.block(cursor)?.hash.toLowerCase())
      throw new Error("Indexed history changed; retry sync");
    const history = this.db.events(end),
      endBlock = await this.chain.getBlock(end);
    if ((await this.chain.getBlock(cursor)).hash !== anchor.hash)
      throw new Error("Chain changed during snapshot; retry");
    return {
      history,
      toBlock: end,
      toBlockHash: endBlock.hash,
      indexedThrough: cursor,
    };
  }
  async export(
    options: { fromBlock?: number; toBlock?: number; merchantId?: string } = {},
  ) {
    const snapshot = await this.snapshot(options.toBlock),
      from = options.fromBlock ?? this.scope.deploymentBlock;
    if (
      !Number.isSafeInteger(from) ||
      from < this.scope.deploymentBlock ||
      from > snapshot.toBlock
    )
      throw new Error("Invalid export range");
    return createExport(snapshot.history, this.scope, {
      fromBlock: from,
      toBlock: snapshot.toBlock,
      toBlockHash: snapshot.toBlockHash,
      merchantId: options.merchantId,
    });
  }
  async ledger(merchantId: string, limit = 100) {
    const snapshot = await this.snapshot();
    const ledger = buildLedger(snapshot.history);
    const entries = ledger.entries.filter(
      (r) => r.merchant_id === merchantId.toLowerCase(),
    );
    const units = (s: string) => BigInt(s.replace(".", ""));
    const sum = (
      field: "gross_usdt" | "relay_fee_usdt" | "refunded_usdt" | "net_usdt",
    ) => formatAmount(entries.reduce((v, r) => v + units(r[field]), 0n));
    return {
      indexedThrough: snapshot.indexedThrough,
      toBlock: snapshot.toBlock,
      totals: {
        gross: sum("gross_usdt"),
        fee: sum("relay_fee_usdt"),
        refunded: sum("refunded_usdt"),
        net: sum("net_usdt"),
      },
      orders: ledger.orders
        .filter((o) => o.merchantId === merchantId.toLowerCase())
        .reverse()
        .slice(0, limit),
      entries: entries.slice(-limit).reverse(),
    };
  }
  start(intervalMs = 5000, log: (error: unknown) => void = () => undefined) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sync().catch(log);
    }, intervalMs);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }
}
