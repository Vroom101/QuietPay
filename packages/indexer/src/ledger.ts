import { token } from "@quietpay/shared";
import { formatAmount } from "./format.js";
import type { LedgerRow, LedgerStatus, RawEvent } from "./types.js";

export interface LedgerConfig {
  router: string;
  /** Bare USDT transfers to this address are recorded as `payto_transfer` deposits, NOT as x402 proof. Omit to disable. */
  facilitatorPayTo?: string;
  decimals?: number;
}

const lc = (s: string) => s.toLowerCase();

export const compareEvents = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }) =>
  a.block - b.block || a.logIndex - b.logIndex;

export function isoUtc(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/**
 * Derives ledger rows from raw events. Pure and deterministic: same events in, same rows out, in any input order.
 *
 * Router source: one row per (merchantId, orderId) from `Paid`, updated by the latest `Refunded.totalRefunded`.
 * payto_transfer source: one row per USDT Transfer to `facilitatorPayTo`, counted ONLY if
 *   (1) `from` is not the router, and
 *   (2) its transaction contains no router `Paid` or `Refunded` log.
 * That stops a router payment whose payout equals `facilitatorPayTo` from being counted twice.
 *
 * net = gross - relayFee - refunded (merchant view). It is negative after a refund beyond gross - fee, because the
 * relay fee is not returned; it is NOT clamped, so summing net_usdt gives the merchant's real result.
 */
export function buildLedgerRows(events: RawEvent[], cfg: LedgerConfig): LedgerRow[] {
  const d = cfg.decimals ?? token.decimals;
  const ZERO_AMOUNT = formatAmount(0n, d);
  const router = lc(cfg.router);
  const payTo = cfg.facilitatorPayTo ? lc(cfg.facilitatorPayTo) : undefined;
  const sorted = [...events].sort(compareEvents);

  const routerTxs = new Set<string>();
  for (const e of sorted) {
    if (lc(e.address) === router && (e.kind === "Paid" || e.kind === "Refunded")) routerTxs.add(lc(e.txHash));
  }

  const rows = new Map<string, LedgerRow & { gross: bigint; fee: bigint; refunded: bigint }>();

  for (const e of sorted) {
    if (lc(e.address) === router && e.kind === "Paid") {
      const key = `${lc(e.args.merchantId!)}:${lc(e.args.orderId!)}`;
      if (rows.has(key)) continue; // the router allows one receipt per order; ignore any later duplicate
      const gross = BigInt(e.args.value!);
      const fee = BigInt(e.args.fee!);
      rows.set(key, {
        key,
        dateUtc: isoUtc(e.timestamp),
        source: "router",
        orderId: lc(e.args.orderId!),
        merchantId: lc(e.args.merchantId!),
        payer: lc(e.args.payer!),
        grossUsdt: formatAmount(gross, d),
        relayFeeUsdt: formatAmount(fee, d),
        refundedUsdt: ZERO_AMOUNT,
        netUsdt: "",
        status: "settled",
        txHash: lc(e.txHash),
        block: e.block,
        logIndex: e.logIndex,
        gross,
        fee,
        refunded: 0n,
      });
    }
  }

  // Refunds apply in chain order; the last totalRefunded wins.
  for (const e of sorted) {
    if (lc(e.address) === router && e.kind === "Refunded") {
      const row = rows.get(`${lc(e.args.merchantId!)}:${lc(e.args.orderId!)}`);
      if (row) row.refunded = BigInt(e.args.totalRefunded!);
    }
  }

  const out: LedgerRow[] = [];
  for (const r of rows.values()) {
    const net = r.gross - r.fee - r.refunded;
    const status: LedgerStatus = r.refunded === 0n ? "settled" : r.refunded >= r.gross ? "refunded" : "partially_refunded";
    const { gross: _g, fee: _f, refunded, ...row } = r;
    out.push({
      ...row,
      refundedUsdt: formatAmount(refunded, d),
      netUsdt: formatAmount(net, d),
      status,
    });
  }

  if (payTo) {
    for (const e of sorted) {
      if (e.kind !== "Transfer" || lc(e.args.to!) !== payTo) continue;
      if (lc(e.args.from!) === router) continue;
      if (routerTxs.has(lc(e.txHash))) continue;
      const gross = BigInt(e.args.value!);
      out.push({
        key: `${lc(e.txHash)}:${e.logIndex}`,
        dateUtc: isoUtc(e.timestamp),
        source: "payto_transfer",
        orderId: "",
        merchantId: "",
        payer: lc(e.args.from!),
        grossUsdt: formatAmount(gross, d),
        relayFeeUsdt: ZERO_AMOUNT,
        refundedUsdt: ZERO_AMOUNT,
        netUsdt: formatAmount(gross, d),
        status: "settled",
        txHash: lc(e.txHash),
        block: e.block,
        logIndex: e.logIndex,
      });
    }
  }

  return out.sort(compareEvents);
}

export const CSV_COLUMNS = [
  "date_utc",
  "source",
  "order_id",
  "merchant_id",
  "payer",
  "gross_usdt",
  "relay_fee_usdt",
  "refunded_usdt",
  "net_usdt",
  "status",
  "tx_hash",
  "block",
  "log_index",
] as const;

function cell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Standard CSV with `\n` line endings, sorted by block then log index. Always ends with a trailing newline. */
export function toCsv(rows: LedgerRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of [...rows].sort(compareEvents)) {
    lines.push(
      [
        r.dateUtc,
        r.source,
        r.orderId,
        r.merchantId,
        r.payer,
        r.grossUsdt,
        r.relayFeeUsdt,
        r.refundedUsdt,
        r.netUsdt,
        r.status,
        r.txHash,
        r.block,
        r.logIndex,
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}
