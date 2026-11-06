import { isAddress, pad, type Hex } from "viem";
import { ConfigError, QUALIFYING_CHAIN_ID, assertQualifyingConfig, getQualifyingDeployment, token } from "@quietpay/shared";
import {
  TOPICS,
  amountText,
  decodeRouter,
  decodeTransfer,
  deriveRows,
  eventSetDigest,
  fetchPaged,
  type SpecEvent,
  type SpecLog,
  type SpecRow,
} from "./spec.js";
import { checkStructure, type Column, type CsvRow } from "./csv.js";
import { parseSidecar } from "./sidecar.js";
import type { CheckName, Issue, VerifierSource, VerifyReport } from "./types.js";

export const VERIFIER_VERSION = "quietpay-verifier/0.1.0";
export const TRUST_NOTE =
  "Re-derived from chain logs and block headers served by the RPC node; the node itself is trusted. " +
  "A payto_transfer row is a deposit, not proof of an x402 API purchase.";

export interface VerifyInput {
  csvText: string;
  metaText: string;
  src: VerifierSource;
  router: string;
  usdt: string;
  /** The facilitator pay-to address the export used (FACILITATOR_PAYTO). Omit if the export had none. */
  payTo?: string;
  decimals?: number;
  /**
   * The range and depth the reader expects, supplied OUTSIDE the export's own sidecar. Without it a forger who edits
   * both the CSV and the sidecar to a smaller range produces a file that looks complete.
   */
  expected?: { fromBlock?: number; toBlock?: number; minConfirmations?: number };
  /** A second, independent node. Its logs for the same range must be identical. */
  src2?: VerifierSource;
  pageSize?: number;
  sleep?: (ms: number) => Promise<void>;
}

const lc = (s: string) => s.toLowerCase();
const CHECKS: CheckName[] = ["structure", "sidecar", "finality", "rows", "event_set_hash", "invariants", "timestamps"];

/** Same guard as the indexer CLI on chain 1874: only the official USDT, and only the qualifying router. */
export function assertQualifying(chainId: number, router: string, usdt: string): void {
  if (chainId !== QUALIFYING_CHAIN_ID) return;
  assertQualifyingConfig({ chainId, tokenAddress: usdt });
  const dep = getQualifyingDeployment();
  if (lc(router) !== lc(dep.router)) throw new ConfigError(`Wrong router: on chain ${QUALIFYING_CHAIN_ID} only the qualifying router ${dep.router} is accepted, got ${router}`);
}

function parseAmount(s: string, decimals: number): bigint | null {
  const m = new RegExp(`^(-?)(\\d+)\\.(\\d{${decimals}})$`).exec(s);
  if (!m) return null;
  const v = BigInt(m[2]!) * 10n ** BigInt(decimals) + BigInt(m[3]!);
  return m[1] ? -v : v;
}

/**
 * Verifies a ledger CSV and its sidecar against the chain. Never reads the indexer's database or the relayer.
 * Throws on RPC errors and on configuration errors (bad address, qualifying guard); everything about the FILE
 * is reported as issues in the returned report.
 */
export async function verifyLedger(input: VerifyInput): Promise<VerifyReport> {
  const { src } = input;
  const decimals = input.decimals ?? token.decimals;
  for (const [name, a] of [["router", input.router], ["usdt", input.usdt], ["payto", input.payTo]] as const) {
    if (a !== undefined && !isAddress(a, { strict: false })) throw new ConfigError(`--${name} is not an address: ${a}`);
  }
  const router = lc(input.router);
  const usdt = lc(input.usdt);
  const payTo = input.payTo ? lc(input.payTo) : undefined;

  const chainId = await src.getChainId();
  assertQualifying(chainId, router, usdt);

  const issues: Issue[] = [];
  const ran = new Set<CheckName>();
  const report: VerifyReport = {
    ok: false,
    verifier: VERIFIER_VERSION,
    chainId,
    router,
    usdt,
    payTo: payTo ?? null,
    fromBlock: null,
    toBlock: null,
    confirmations: null,
    headBlock: null,
    finalizedBlock: null,
    rowsInCsv: 0,
    rowsExpected: null,
    eventsInRange: null,
    eventSetHash: { sidecar: null, recomputed: null },
    anchored: false,
    checkpoint: null,
    checks: Object.fromEntries(CHECKS.map((c) => [c, "skipped"])) as VerifyReport["checks"],
    issues,
    trust: TRUST_NOTE,
  };
  const finish = () => {
    for (const c of CHECKS) report.checks[c] = issues.some((i) => i.check === c) ? "fail" : ran.has(c) ? "pass" : "skipped";
    report.ok = issues.length === 0 && CHECKS.every((c) => report.checks[c] === "pass");
    return report;
  };

  // 1. Structure.
  ran.add("structure");
  const st = checkStructure(input.csvText, decimals);
  issues.push(...st.issues);
  report.rowsInCsv = st.dataLines;
  const csvRows = st.rows;

  // Sidecar.
  ran.add("sidecar");
  const sc = parseSidecar(input.metaText);
  if ("error" in sc) {
    issues.push({ check: "sidecar", code: "bad_sidecar", message: sc.error });
    return finish();
  }
  const meta = sc.meta;
  Object.assign(report, { fromBlock: meta.fromBlock, toBlock: meta.toBlock, confirmations: meta.confirmations });
  report.eventSetHash.sidecar = meta.eventSetHash;
  for (const r of csvRows) {
    if (r.block < meta.fromBlock || r.block > meta.toBlock) {
      issues.push({ check: "structure", code: "row_out_of_range", line: r.line, key: r.key, message: `block ${r.block} is outside the sidecar range ${meta.fromBlock}-${meta.toBlock}` });
    }
  }

  const want = input.expected ?? {};
  report.anchored = want.fromBlock !== undefined && want.toBlock !== undefined && want.minConfirmations !== undefined;
  for (const [name, mine, theirs] of [["router", router, meta.router], ["usdt", usdt, meta.usdt], ["payTo", payTo ?? null, meta.payTo]] as const) {
    if (theirs !== undefined && theirs !== mine) {
      issues.push({
        check: "sidecar",
        code: "config_mismatch",
        field: name,
        expected: String(theirs),
        actual: String(mine),
        message: `sidecar says the export covered ${name} ${theirs}, but the verifier was run with ${mine}; stripped or swapped inputs cannot be verified`,
      });
    }
  }
  for (const [name, exp, got] of [["fromBlock", want.fromBlock, meta.fromBlock], ["toBlock", want.toBlock, meta.toBlock]] as const) {
    if (exp !== undefined && exp !== got) {
      issues.push({
        check: "sidecar",
        code: "range_mismatch",
        field: name,
        expected: String(exp),
        actual: String(got),
        message: `sidecar ${name} ${got} differs from the expected ${exp}: the export may be truncated or shifted`,
      });
    }
  }

  // 2. Finality: refuse a range that reaches past head - confirmations.
  ran.add("finality");
  if (want.minConfirmations !== undefined && meta.confirmations < want.minConfirmations) {
    issues.push({
      check: "finality",
      code: "confirmations_below_expected",
      field: "confirmations",
      expected: `>= ${want.minConfirmations}`,
      actual: String(meta.confirmations),
      message: `export used ${meta.confirmations} confirmations, fewer than the ${want.minConfirmations} required`,
    });
  }
  const head = await src.getBlockNumber();
  const finalized = head - Math.max(meta.confirmations, want.minConfirmations ?? 0);
  report.headBlock = head;
  report.finalizedBlock = finalized;
  if (meta.toBlock > finalized) {
    issues.push({
      check: "finality",
      code: "to_block_not_final",
      message: `sidecar toBlock ${meta.toBlock} is beyond the finalized block ${finalized} (head ${head} - ${meta.confirmations} confirmations); refusing to verify non-final blocks`,
      expected: `<= ${finalized}`,
      actual: String(meta.toBlock),
    });
    return finish();
  }

  // Fetch and decode, like the indexer does, but straight from the node.
  const paging = { pageSize: input.pageSize, sleep: input.sleep };
  const timestamps = new Map<number, number>();
  const timestamp = async (n: number) => {
    if (!timestamps.has(n)) timestamps.set(n, (await src.getBlock(n)).timestamp);
    return timestamps.get(n)!;
  };
  const fetchLogs = async (node: VerifierSource) => {
    const logs: SpecLog[] = [];
    logs.push(...(await fetchPaged(node, { address: router }, meta.fromBlock, meta.toBlock, paging)));
    if (payTo) {
      const toTopic = lc(pad(payTo as Hex, { size: 32 }));
      logs.push(...(await fetchPaged(node, { address: usdt, topics: [TOPICS.Transfer, null, toTopic] }, meta.fromBlock, meta.toBlock, paging)));
    }
    return logs;
  };
  const fingerprint = (logs: SpecLog[]) =>
    logs
      .map((l) => `${lc(l.transactionHash)}:${l.logIndex}:${l.blockNumber}:${lc(l.address)}:${l.topics.map(lc).join("|")}:${lc(l.data)}`)
      .sort()
      .join(";");
  const primaryLogs = await fetchLogs(src);
  if (input.src2) {
    const second = await fetchLogs(input.src2);
    if (fingerprint(second) !== fingerprint(primaryLogs)) {
      issues.push({
        check: "event_set_hash",
        code: "rpc_disagreement",
        expected: `${primaryLogs.length} logs`,
        actual: `${second.length} logs`,
        message: `the two RPC nodes returned different logs for blocks ${meta.fromBlock}-${meta.toBlock} (${primaryLogs.length} vs ${second.length}); do not trust either until resolved`,
      });
    }
  }
  const decoded: { log: SpecLog; kind: SpecEvent["kind"]; args: Record<string, string> }[] = [];
  for (const log of primaryLogs) {
    const ev = log.address.toLowerCase() === router ? decodeRouter(log) : decodeTransfer(log);
    if (ev) decoded.push({ log, ...ev });
  }
  const events: SpecEvent[] = [];
  for (const { log, kind, args } of decoded) {
    events.push({
      txHash: lc(log.transactionHash),
      logIndex: log.logIndex,
      block: log.blockNumber,
      timestamp: await timestamp(log.blockNumber),
      address: lc(log.address),
      kind,
      args,
    });
  }
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  report.eventsInRange = events.length;

  // 3. Rebuild the rows with the verifier's own rules (src/spec.ts) and compare row by row.
  ran.add("rows");
  const expected = deriveRows(events, { router, payTo, decimals }).filter((r) => r.block >= meta.fromBlock && r.block <= meta.toBlock);
  report.rowsExpected = expected.length;
  issues.push(...compareRows(csvRows, expected));

  // 4. Event set hash.
  ran.add("event_set_hash");
  const recomputed = eventSetDigest(events);
  report.eventSetHash.recomputed = recomputed;
  report.checkpoint = { fromBlock: meta.fromBlock, toBlock: meta.toBlock, eventCount: events.length, eventSetHash: recomputed };
  if (recomputed !== meta.eventSetHash) {
    issues.push({
      check: "event_set_hash",
      code: "event_set_hash_mismatch",
      message: `sidecar eventSetHash ${meta.eventSetHash} differs from the hash of the ${events.length} events on chain in ${meta.fromBlock}-${meta.toBlock} (${recomputed})`,
      expected: recomputed,
      actual: meta.eventSetHash,
    });
  }

  // 5. Invariants straight from chain events and the USDT transfers in each settlement tx.
  ran.add("invariants");
  issues.push(...(await checkInvariants(csvRows, events, { src, usdt, router, decimals })));

  // 6. Block timestamps.
  ran.add("timestamps");
  for (const r of csvRows) {
    if (r.block < meta.fromBlock || r.block > meta.toBlock) continue; // already reported; do not read non-final blocks
    const want = new Date((await timestamp(r.block)) * 1000).toISOString();
    if (r.cells.date_utc !== want) {
      issues.push({ check: "timestamps", code: "wrong_date", line: r.line, key: r.key, field: "date_utc", expected: want, actual: r.cells.date_utc, message: `date_utc ${r.cells.date_utc} is not the timestamp of block ${r.block} (${want})` });
    }
  }

  return finish();
}

/** Expected value of each CSV column for a rebuilt row (dates are checked separately against the block). */
function expectedCells(r: SpecRow): Record<Exclude<Column, "date_utc">, string> {
  return {
    source: r.source,
    order_id: r.orderId,
    merchant_id: r.merchantId,
    payer: r.payer,
    gross_usdt: r.gross,
    relay_fee_usdt: r.fee,
    refunded_usdt: r.refunded,
    net_usdt: r.net,
    status: r.status,
    tx_hash: r.txHash,
    block: String(r.block),
    log_index: String(r.logIndex),
  };
}

const FIELD_CODE: Record<Exclude<Column, "date_utc">, Issue["code"]> = {
  source: "wrong_field",
  order_id: "wrong_field",
  merchant_id: "wrong_field",
  payer: "wrong_field",
  gross_usdt: "wrong_amount",
  relay_fee_usdt: "wrong_amount",
  refunded_usdt: "wrong_refunded",
  net_usdt: "wrong_amount",
  status: "wrong_status",
  tx_hash: "wrong_tx_hash",
  block: "wrong_block",
  log_index: "wrong_log_index",
};

/**
 * Matches CSV rows to rebuilt rows by `tx_hash:log_index`. Leftovers are paired by tx hash (so a wrong block or log
 * index is named as such) or by (block, log index) (a wrong tx hash); anything still unpaired is missing or extra.
 */
export function compareRows(csvRows: CsvRow[], expected: SpecRow[]): Issue[] {
  const issues: Issue[] = [];
  const expByKey = new Map(expected.map((r) => [`${r.txHash}:${r.logIndex}`, r]));
  const pairs: [CsvRow, SpecRow][] = [];
  const extra: CsvRow[] = [];
  const used = new Set<SpecRow>();
  for (const c of csvRows) {
    const e = expByKey.get(c.key);
    if (e) {
      pairs.push([c, e]);
      used.add(e);
    } else extra.push(c);
  }
  const left = () => expected.filter((e) => !used.has(e));
  const stillExtra: CsvRow[] = [];
  for (const c of extra) {
    const e =
      left().find((x) => x.txHash === c.cells.tx_hash && x.source === c.cells.source) ??
      left().find((x) => x.txHash === c.cells.tx_hash) ??
      left().find((x) => x.block === c.block && x.logIndex === c.logIndex);
    if (e) {
      pairs.push([c, e]);
      used.add(e);
    } else stillExtra.push(c);
  }

  for (const [c, e] of pairs) {
    const want = expectedCells(e);
    for (const [field, value] of Object.entries(want) as [Exclude<Column, "date_utc">, string][]) {
      if (c.cells[field] === value) continue;
      issues.push({
        check: "rows",
        code: FIELD_CODE[field],
        line: c.line,
        key: `${e.txHash}:${e.logIndex}`,
        field,
        expected: value,
        actual: c.cells[field],
        message: `${field} is ${c.cells[field]}, chain says ${value}`,
      });
    }
  }
  for (const c of stillExtra) {
    issues.push({ check: "rows", code: "extra_row", line: c.line, key: c.key, message: `row ${c.key} (${c.cells.source}, ${c.cells.gross_usdt}) has no matching event on chain in range` });
  }
  for (const e of left()) {
    issues.push({ check: "rows", code: "missing_row", key: `${e.txHash}:${e.logIndex}`, expected: `${e.source} ${e.gross} at block ${e.block}`, message: `chain has a ${e.source} row ${e.txHash}:${e.logIndex} (block ${e.block}, gross ${e.gross}) that the CSV lacks` });
  }
  return issues.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
}

/**
 * Invariants from chain data, independent of buildSpecRows: for every CSV router row backed by a Paid log,
 * gross == Paid.value, fee == Paid.fee, refunded == latest Refunded.totalRefunded, net == gross - fee - refunded (may be negative),
 * status consistent, and the USDT Transfers in the Paid tx are exactly what the router does:
 * payer -> router gross, router -> payout gross - fee, router -> relayer fee (if fee > 0).
 */
async function checkInvariants(
  csvRows: CsvRow[],
  events: SpecEvent[],
  ctx: { src: VerifierSource; usdt: string; router: string; decimals: number },
): Promise<Issue[]> {
  const issues: Issue[] = [];
  const fmt = (v: bigint) => amountText(v, ctx.decimals);
  const paid = new Map(events.filter((e) => e.kind === "Paid" && e.address === ctx.router).map((e) => [`${e.txHash}:${e.logIndex}`, e]));
  const latestRefund = new Map<string, bigint>();
  for (const e of events) {
    if (e.kind === "Refunded" && e.address === ctx.router) latestRefund.set(`${e.args.merchantId}:${e.args.orderId}`, BigInt(e.args.totalRefunded!));
  }
  const transfersByBlock = new Map<number, SpecLog[]>();

  for (const r of csvRows) {
    if (r.cells.source !== "router") continue;
    const p = paid.get(r.key);
    if (!p) continue; // reported by the row comparison (extra row / wrong key)
    const at = { check: "invariants" as const, line: r.line, key: r.key };
    const value = BigInt(p.args.value!);
    const fee = BigInt(p.args.fee!);
    const refunded = latestRefund.get(`${p.args.merchantId}:${p.args.orderId}`) ?? 0n;
    const gross = parseAmount(r.cells.gross_usdt, ctx.decimals);
    const feeCsv = parseAmount(r.cells.relay_fee_usdt, ctx.decimals);
    const refCsv = parseAmount(r.cells.refunded_usdt, ctx.decimals);
    const net = parseAmount(r.cells.net_usdt, ctx.decimals);
    if (gross !== null && gross !== value) issues.push({ ...at, code: "invariant_gross", field: "gross_usdt", expected: fmt(value), actual: r.cells.gross_usdt, message: `gross ${r.cells.gross_usdt} != Paid.value ${fmt(value)}` });
    if (feeCsv !== null && feeCsv !== fee) issues.push({ ...at, code: "invariant_fee", field: "relay_fee_usdt", expected: fmt(fee), actual: r.cells.relay_fee_usdt, message: `relay fee ${r.cells.relay_fee_usdt} != Paid.fee ${fmt(fee)}` });
    if (refCsv !== null && refCsv !== refunded) issues.push({ ...at, code: "invariant_refunded", field: "refunded_usdt", expected: fmt(refunded), actual: r.cells.refunded_usdt, message: `refunded ${r.cells.refunded_usdt} != latest Refunded.totalRefunded ${fmt(refunded)}` });
    if (gross !== null && feeCsv !== null && refCsv !== null && net !== null) {
      const d = gross - feeCsv - refCsv;
      const want = d;
      if (net !== want) issues.push({ ...at, code: "invariant_net", field: "net_usdt", expected: fmt(want), actual: r.cells.net_usdt, message: `net ${r.cells.net_usdt} != gross - fee - refunded = ${fmt(want)}` });
      const status = refCsv === 0n ? "settled" : refCsv >= gross ? "refunded" : "partially_refunded";
      if (r.cells.status !== status) issues.push({ ...at, code: "invariant_status", field: "status", expected: status, actual: r.cells.status, message: `status ${r.cells.status} does not fit refunded ${r.cells.refunded_usdt} of gross ${r.cells.gross_usdt} (${status})` });
    }

    // The real USDT transfers inside the settlement transaction.
    if (!transfersByBlock.has(p.block)) {
      transfersByBlock.set(p.block, await fetchPaged(ctx.src, { address: ctx.usdt, topics: [TOPICS.Transfer] }, p.block, p.block));
    }
    const inTx = transfersByBlock
      .get(p.block)!
      .filter((l) => lc(l.transactionHash) === p.txHash)
      .map((l) => decodeTransfer(l))
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .map((d) => ({ from: d.args.from!, to: d.args.to!, value: BigInt(d.args.value!) }));
    const want = [
      { from: p.args.payer!, to: ctx.router, value, what: "pull of gross (payer -> router)" },
      { from: ctx.router, to: p.args.payout!, value: value - fee, what: "payout of gross - fee (router -> payout)" },
      ...(fee > 0n ? [{ from: ctx.router, to: p.args.relayer!, value: fee, what: "relayer fee (router -> relayer)" }] : []),
    ];
    const pool = [...inTx];
    for (const w of want) {
      const i = pool.findIndex((t) => t.from === w.from && t.to === w.to && t.value === w.value);
      if (i >= 0) {
        pool.splice(i, 1);
        continue;
      }
      const found = inTx.map((t) => `${t.from}->${t.to} ${fmt(t.value)}`).join("; ") || "none";
      issues.push({
        ...at,
        code: "transfer_mismatch",
        expected: `${w.from}->${w.to} ${fmt(w.value)}`,
        message: `tx ${p.txHash}: no USDT Transfer ${w.from} -> ${w.to} of ${fmt(w.value)} (${w.what}); transfers in tx: ${found}`,
      });
    }
  }
  return issues;
}
