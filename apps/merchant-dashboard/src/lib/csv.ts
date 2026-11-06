import { formatUsdt } from "@quietpay/shared";
import type { DashboardOrder } from "./view";

/** 1 WBT = 10^18 wei. Shown with up to 8 decimals (trailing zeros trimmed); exact, no float. */
export function formatWbt(wei: bigint | string, decimals = 8): string {
  const v = BigInt(wei);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * One CSV cell. Quotes when needed, and defuses spreadsheet formulas: a text cell starting with = + @ tab or CR, or
 * or "-", gets a leading apostrophe (OWASP CSV injection guidance), unless the whole value is a plain number
 * (/^-?\d+(\.\d+)?$/), so -0.50 stays a number but -2+3+cmd|x does not.
 */
export function csvCell(value: string | number | bigint | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface TransactionsCsvOptions {
  /** Adds gas_wbt (network gas the relayer paid for this order's pay, refund and retry transactions). */
  includeGas: boolean;
}

const iso = (t: number | undefined) => (t ? new Date(t * 1000).toISOString() : "");

/** The dashboard's transactions as CSV. Amounts are exact decimal USDT strings; net = amount - fee - refunded. */
export function buildTransactionsCsv(orders: DashboardOrder[], { includeGas }: TransactionsCsvOptions): string {
  const header = ["created_utc", "settled_utc", "order_id", "reference", "status", "payer", "amount_usdt", "relay_fee_usdt", "refunded_usdt", "net_usdt", "refund_count"];
  if (includeGas) header.push("gas_wbt");
  const lines = [header.join(",")];
  for (const o of orders) {
    const paid = ["settled", "partially_refunded", "refunded"].includes(o.status);
    const amount = BigInt(o.amount);
    const fee = paid ? BigInt(o.fee) : 0n;
    const refunded = BigInt(o.refunded ?? "0");
    const net = paid ? amount - fee - refunded : 0n;
    const signed = (v: bigint) => (v < 0n ? `-${formatUsdt(-v)}` : formatUsdt(v));
    const row = [iso(o.createdAt), iso(o.settledAt), o.id, o.reference ?? "", o.status, o.payer ?? "", formatUsdt(amount), formatUsdt(fee), formatUsdt(refunded), signed(net), o.refundCount ?? 0];
    if (includeGas) row.push(o.gasWei === undefined ? "" : formatWbt(o.gasWei, 18));
    lines.push(row.map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

/** Saves text as a file in the browser (Blob + temporary link). */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
