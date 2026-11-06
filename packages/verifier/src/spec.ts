/**
 * Independent re-implementation of the ledger rules, written from docs/lead/ledger.md and NOT from the indexer's
 * code: its own log decoding (raw topic and data words), its own row derivation, its own event-set hash, its own
 * amount formatting and its own block paging. The differential test in test/differential.test.ts feeds random
 * event sets to this and to the indexer and requires identical rows; any difference is settled by the spec text.
 */
import { createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";

export interface SpecLog {
  address: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  topics: string[];
  data: string;
}

export type SpecKind = "Paid" | "Refunded" | "MerchantRegistered" | "PayoutChanged" | "RelayerSet" | "Transfer";

export interface SpecEvent {
  txHash: string;
  logIndex: number;
  block: number;
  timestamp: number;
  address: string;
  kind: SpecKind;
  args: Record<string, string>;
}

export interface SpecRow {
  dateUtc: string;
  source: "router" | "payto_transfer";
  orderId: string;
  merchantId: string;
  payer: string;
  gross: string;
  fee: string;
  refunded: string;
  net: string;
  status: "settled" | "partially_refunded" | "refunded";
  txHash: string;
  block: number;
  logIndex: number;
}

const lc = (s: string) => s.toLowerCase();
const sig = (s: string) => keccak256(toBytes(s));

export const TOPICS = {
  Paid: sig("Paid(bytes32,bytes32,address,address,uint256,uint256,address)"),
  Refunded: sig("Refunded(bytes32,bytes32,address,uint256,uint256,uint256)"),
  MerchantRegistered: sig("MerchantRegistered(bytes32,address,address,uint256)"),
  PayoutChanged: sig("PayoutChanged(bytes32,address)"),
  RelayerSet: sig("RelayerSet(address,bool)"),
  Transfer: sig("Transfer(address,address,uint256)"),
};

const hex = (s: string) => (s.startsWith("0x") ? s.slice(2) : s);
const word = (data: string, i: number) => hex(data).slice(i * 64, i * 64 + 64);
const addrOf = (w: string) => "0x" + w.slice(24).toLowerCase();
const isWord = (s: string | undefined) => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
const bigOf = (w: string) => BigInt("0x" + w).toString();

/** Decodes a log of the router. Returns null for anything the ledger does not use or that is malformed. */
export function decodeRouter(l: SpecLog): { kind: SpecKind; args: Record<string, string> } | null {
  const t0 = lc(l.topics[0] ?? "");
  const d = hex(l.data);
  if (t0 === TOPICS.Paid) {
    if (l.topics.length !== 4 || !l.topics.slice(1).every(isWord) || d.length !== 4 * 64) return null;
    return {
      kind: "Paid",
      args: {
        merchantId: lc(l.topics[1]!),
        orderId: lc(l.topics[2]!),
        payer: addrOf(hex(l.topics[3]!)),
        payout: addrOf(word(d, 0)),
        value: bigOf(word(d, 1)),
        fee: bigOf(word(d, 2)),
        relayer: addrOf(word(d, 3)),
      },
    };
  }
  if (t0 === TOPICS.Refunded) {
    if (l.topics.length !== 4 || !l.topics.slice(1).every(isWord) || d.length !== 3 * 64) return null;
    return {
      kind: "Refunded",
      args: {
        merchantId: lc(l.topics[1]!),
        orderId: lc(l.topics[2]!),
        payer: addrOf(hex(l.topics[3]!)),
        amount: bigOf(word(d, 0)),
        totalRefunded: bigOf(word(d, 1)),
        refundIndex: bigOf(word(d, 2)),
      },
    };
  }
  // Operator events only matter to the event-set hash, not to any row.
  if (t0 === TOPICS.MerchantRegistered && l.topics.length === 2 && d.length === 3 * 64) return { kind: "MerchantRegistered", args: {} };
  if (t0 === TOPICS.PayoutChanged && l.topics.length === 2 && d.length === 64) return { kind: "PayoutChanged", args: {} };
  if (t0 === TOPICS.RelayerSet && l.topics.length === 2 && d.length === 64) return { kind: "RelayerSet", args: {} };
  return null;
}

/** ERC-20 Transfer only (three topics; an ERC-721 Transfer has four and is rejected). */
export function decodeTransfer(l: SpecLog): { kind: SpecKind; args: Record<string, string> } | null {
  if (lc(l.topics[0] ?? "") !== TOPICS.Transfer || l.topics.length !== 3) return null;
  if (!isWord(l.topics[1]) || !isWord(l.topics[2]) || hex(l.data).length !== 64) return null;
  return { kind: "Transfer", args: { from: addrOf(hex(l.topics[1]!)), to: addrOf(hex(l.topics[2]!)), value: bigOf(word(l.data, 0)) } };
}

export function amountText(base: bigint, decimals: number): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const s = v.toString().padStart(decimals + 1, "0");
  const cut = s.length - decimals;
  return (neg ? "-" : "") + s.slice(0, cut) + (decimals ? "." + s.slice(cut) : "");
}

export function eventSetDigest(events: { txHash: string; logIndex: number }[]): string {
  return createHash("sha256")
    .update(events.map((e) => `${lc(e.txHash)}:${e.logIndex}`).sort().join("\n"))
    .digest("hex");
}

/**
 * Ledger rules from the spec: one router row per (merchantId, orderId) from the FIRST Paid; refunded = the last
 * Refunded.totalRefunded in chain order; net = max(0, gross - fee - refunded); status by refunded vs gross; a
 * Transfer to `payTo` becomes a payto_transfer row unless it comes from the router or sits in a transaction that has
 * a router Paid or Refunded log. Rows are ordered by block then log index.
 */
export function deriveRows(events: SpecEvent[], cfg: { router: string; payTo?: string; decimals: number }): SpecRow[] {
  const router = lc(cfg.router);
  const payTo = cfg.payTo ? lc(cfg.payTo) : undefined;
  const ordered = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const fromRouter = (e: SpecEvent) => lc(e.address) === router;
  const settlementTxs = new Set(
    ordered.filter((e) => fromRouter(e) && (e.kind === "Paid" || e.kind === "Refunded")).map((e) => lc(e.txHash)),
  );
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const rows: SpecRow[] = [];
  const byOrder = new Map<string, { row: SpecRow; value: bigint; fee: bigint; refunded: bigint }>();

  for (const e of ordered) {
    if (fromRouter(e) && e.kind === "Paid") {
      const key = `${lc(e.args.merchantId!)}/${lc(e.args.orderId!)}`;
      if (byOrder.has(key)) continue;
      const row: SpecRow = {
        dateUtc: iso(e.timestamp),
        source: "router",
        orderId: lc(e.args.orderId!),
        merchantId: lc(e.args.merchantId!),
        payer: lc(e.args.payer!),
        gross: "",
        fee: "",
        refunded: "",
        net: "",
        status: "settled",
        txHash: lc(e.txHash),
        block: e.block,
        logIndex: e.logIndex,
      };
      byOrder.set(key, { row, value: BigInt(e.args.value!), fee: BigInt(e.args.fee!), refunded: 0n });
    }
  }
  for (const e of ordered) {
    if (fromRouter(e) && e.kind === "Refunded") {
      const o = byOrder.get(`${lc(e.args.merchantId!)}/${lc(e.args.orderId!)}`);
      if (o) o.refunded = BigInt(e.args.totalRefunded!);
    }
  }
  for (const { row, value, fee, refunded } of byOrder.values()) {
    const left = value - fee - refunded;
    row.gross = amountText(value, cfg.decimals);
    row.fee = amountText(fee, cfg.decimals);
    row.refunded = amountText(refunded, cfg.decimals);
    row.net = amountText(left > 0n ? left : 0n, cfg.decimals);
    row.status = refunded === 0n ? "settled" : refunded >= value ? "refunded" : "partially_refunded";
    rows.push(row);
  }
  if (payTo) {
    for (const e of ordered) {
      if (e.kind !== "Transfer" || lc(e.args.to!) !== payTo || lc(e.args.from!) === router || settlementTxs.has(lc(e.txHash))) continue;
      const v = BigInt(e.args.value!);
      rows.push({
        dateUtc: iso(e.timestamp),
        source: "payto_transfer",
        orderId: "",
        merchantId: "",
        payer: lc(e.args.from!),
        gross: amountText(v, cfg.decimals),
        fee: amountText(0n, cfg.decimals),
        refunded: amountText(0n, cfg.decimals),
        net: amountText(v, cfg.decimals),
        status: "settled",
        txHash: lc(e.txHash),
        block: e.block,
        logIndex: e.logIndex,
      });
    }
  }
  return rows.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

export interface SpecLogSource {
  getLogs(q: { address: string; fromBlock: number; toBlock: number; topics?: (string | null)[] }): Promise<SpecLog[]>;
}

const tooWide = (e: unknown) =>
  /-32062|block range|range is too (large|wide)|too many (blocks|results)|query returned more than/i.test(
    String((e as { message?: string })?.message ?? e) + String((e as { code?: unknown })?.code ?? ""),
  );

const isRateLimit = (e: unknown) => /429|rate.?limit|too many requests|exceeded/i.test(String((e as { message?: string })?.message ?? e));

/** Pages eth_getLogs in <= `page` blocks, halving the page when the node says the range is too wide. */
export async function fetchPaged(
  src: SpecLogSource,
  q: { address: string; topics?: (string | null)[] },
  from: number,
  to: number,
  opts: { page?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SpecLog[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let retries = 0;
  const out: SpecLog[] = [];
  let size = Math.min(opts.page ?? 1000, 1000);
  let a = from;
  while (a <= to) {
    const b = Math.min(a + size - 1, to);
    try {
      const got = await src.getLogs({ ...q, fromBlock: a, toBlock: b });
      for (const l of got) if (!(l as { removed?: boolean }).removed) out.push(l);
      a = b + 1;
      retries = 0;
    } catch (e) {
      if (tooWide(e) && size > 1) size = Math.max(1, Math.floor(size / 2));
      else if (isRateLimit(e) && retries < 6) {
        await sleep(Math.min(30_000, 500 * 2 ** retries));
        retries += 1;
      } else throw e;
    }
  }
  const seen = new Set<string>();
  return out.filter((l) => {
    const k = `${lc(l.transactionHash)}:${l.logIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
