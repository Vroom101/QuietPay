import { createHash } from "node:crypto";
import { pad, type Hex } from "viem";
import { IndexerDb } from "./db.js";
import { decodeRouterLog, decodeTransferLog, TRANSFER_TOPIC } from "./decode.js";
import { buildLedgerRows, toCsv } from "./ledger.js";
import { getLogsPaged, type LogSource } from "./rpc.js";
import type { ChainLog, ExportMeta, LedgerRow, RawEvent } from "./types.js";

export interface IndexerConfig {
  router: string;
  usdt: string;
  /** Bare USDT Transfers to this address are recorded as payto_transfer deposits (not x402 proof). Optional. */
  facilitatorPayTo?: string;
  /** A block is final after this many confirmations. A setting, not a proof of finality. */
  confirmations: number;
  /** First block to scan (the router's deploy block). */
  deployBlock: number;
  decimals?: number;
  pageSize?: number;
}

export interface Deps {
  db: IndexerDb;
  src: LogSource;
  cfg: IndexerConfig;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  onRequest?: (from: number, to: number) => void;
}

const lc = (s: string) => s.toLowerCase();

export interface IndexResult {
  from: number;
  to: number;
  newEvents: number;
  head: number;
  finalized: number;
}

function ledgerCfg(cfg: IndexerConfig) {
  return { router: cfg.router, facilitatorPayTo: cfg.facilitatorPayTo, decimals: cfg.decimals };
}

/**
 * Catches up once. Only FINALIZED blocks (head - confirmations) are ever stored, and the cursor only advances to a
 * finalized block, so a reorg inside the unfinalized window cannot leave stale rows: those blocks are simply read
 * again on the next run, once they are final. Finalized data is never deleted. If the stored cursor block hash no
 * longer matches the chain, a reorg deeper than `confirmations` happened and the indexer stops instead of guessing.
 */
export async function indexOnce(d: Deps): Promise<IndexResult> {
  const { db, src, cfg } = d;
  const head = await src.getBlockNumber();
  const finalized = head - cfg.confirmations;
  const cursor = db.getCursor();
  const start = cursor ? cursor.block + 1 : cfg.deployBlock;

  if (cursor) {
    const onChain = await src.getBlock(cursor.block);
    if (onChain.hash !== cursor.hash) {
      throw new Error(
        `reorg deeper than ${cfg.confirmations} confirmations at block ${cursor.block}; ` +
          `refusing to continue. Raise CONFIRMATIONS and re-index from a fresh database.`,
      );
    }
  }
  if (finalized < start) return { from: start, to: finalized, newEvents: 0, head, finalized };

  const paging = { pageSize: cfg.pageSize, sleep: d.sleep, onRequest: d.onRequest };
  const routerLogs = await getLogsPaged(src, { address: cfg.router }, start, finalized, paging);
  const decoded: { log: ChainLog; kind: RawEvent["kind"]; args: Record<string, string> }[] = [];
  for (const log of routerLogs) {
    const ev = decodeRouterLog(log);
    if (ev) decoded.push({ log, ...ev });
  }
  if (cfg.facilitatorPayTo) {
    const toTopic = pad(cfg.facilitatorPayTo as Hex, { size: 32 }).toLowerCase();
    const transfers = await getLogsPaged(src, { address: cfg.usdt, topics: [TRANSFER_TOPIC, null, toTopic] }, start, finalized, paging);
    for (const log of transfers) {
      const ev = decodeTransferLog(log);
      if (ev) decoded.push({ log, ...ev });
    }
  }

  const blocks = new Map<number, number>(); // block -> timestamp
  for (const { log } of decoded) {
    if (!blocks.has(log.blockNumber)) blocks.set(log.blockNumber, (await src.getBlock(log.blockNumber)).timestamp);
  }
  const events: RawEvent[] = decoded.map(({ log, kind, args }) => ({
    txHash: lc(log.transactionHash),
    logIndex: log.logIndex,
    block: log.blockNumber,
    blockHash: lc(log.blockHash),
    timestamp: blocks.get(log.blockNumber)!,
    address: lc(log.address),
    kind,
    args,
  }));

  const finalizedHash = (await src.getBlock(finalized)).hash;
  const newEvents = db.transaction(() => {
    const n = db.insertEvents(events);
    db.setCursor(finalized, finalizedHash);
    // Recompute rows for everything touched by this batch (orders whose Paid/Refunded arrived, new transfers).
    const all = buildLedgerRows(db.events(), ledgerCfg(cfg));
    const touchedOrders = new Set(
      events.filter((e) => e.kind === "Paid" || e.kind === "Refunded").map((e) => `${e.args.merchantId}:${e.args.orderId}`),
    );
    const touchedTxs = new Set(events.map((e) => `${e.txHash}:${e.logIndex}`));
    db.upsertLedger(all.filter((r) => touchedOrders.has(r.key) || touchedTxs.has(r.key)));
    return n;
  });
  d.log?.(`indexed blocks ${start}-${finalized}: ${events.length} events (${newEvents} new)`);
  return { from: start, to: finalized, newEvents, head, finalized };
}

/** Wipes the derived ledger and recomputes it from raw events. Raw events are untouched. */
export function rebuild(db: IndexerDb, cfg: IndexerConfig): LedgerRow[] {
  const rows = buildLedgerRows(db.events(), ledgerCfg(cfg));
  db.transaction(() => {
    db.clearLedger();
    db.upsertLedger(rows);
  });
  return rows;
}

export function eventSetHash(events: Pick<RawEvent, "txHash" | "logIndex">[]): string {
  const lines = events.map((e) => `${lc(e.txHash)}:${e.logIndex}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export interface ExportResult {
  csv: string;
  meta: ExportMeta;
  rows: LedgerRow[];
}

/**
 * Builds the CSV and sidecar for [from, to]. `to` is clamped to the finalized cursor, so non-final blocks are never
 * included. Rows are those whose payment (or payto_transfer deposit) landed in range, with refunds applied up to `to`.
 * The CSV is a pure function of the stored raw events, so the same range always gives the same bytes.
 */
export function buildExport(
  db: IndexerDb,
  cfg: IndexerConfig,
  opts: { from?: number; to?: number; generatedAt?: string },
): ExportResult {
  const cursor = db.getCursor();
  const finalizedHead = cursor?.block ?? cfg.deployBlock - 1;
  const from = opts.from ?? cfg.deployBlock;
  const to = Math.min(opts.to ?? finalizedHead, finalizedHead);
  const upTo = db.events({ toBlock: to });
  const rows = buildLedgerRows(upTo, ledgerCfg(cfg)).filter((r) => r.block >= from && r.block <= to);
  const inRange = upTo.filter((e) => e.block >= from);
  return {
    csv: toCsv(rows),
    rows,
    meta: {
      fromBlock: from,
      toBlock: to,
      confirmations: cfg.confirmations,
      eventSetHash: eventSetHash(inRange),
      hashVersion: 2,
      router: cfg.router.toLowerCase(),
      usdt: cfg.usdt.toLowerCase(),
      payTo: cfg.facilitatorPayTo ? cfg.facilitatorPayTo.toLowerCase() : null,
      generatedAt: opts.generatedAt ?? new Date().toISOString(),
    },
  };
}
