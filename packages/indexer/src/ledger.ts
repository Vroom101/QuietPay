import { uniqueEvents, type RecordedEvent } from "./model.js";

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
export type Column = (typeof CSV_COLUMNS)[number];
export type LedgerRow = Record<Column, string>;
export interface OrderLedger {
  orderId: string;
  merchantId: string;
  payer: string;
  payout: string;
  gross: string;
  fee: string;
  refunded: string;
  net: string;
  refundCount: number;
  status: "paid" | "partially_refunded" | "refunded";
  txHash: string;
  block: number;
  logIndex: number;
}
export function formatAmount(value: bigint): string {
  const sign = value < 0n ? "-" : "",
    abs = value < 0n ? -value : value;
  return `${sign}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}
export function buildLedger(history: RecordedEvent[]): {
  entries: LedgerRow[];
  orders: OrderLedger[];
} {
  const entries: LedgerRow[] = [];
  const orders = new Map<
    string,
    {
      paid: bigint;
      fee: bigint;
      refunded: bigint;
      count: bigint;
      view: OrderLedger;
    }
  >();
  for (const { event: e, timestamp } of uniqueEvents(history)) {
    if (e.type === "MerchantRegistered" || e.type === "PayoutChanged") continue;
    const row: LedgerRow = {
      date_utc: new Date(timestamp * 1000).toISOString(),
      source: "router",
      order_id: e.type === "AgentTransfer" ? "" : e.orderId,
      merchant_id: e.merchantId,
      payer: e.payer,
      gross_usdt: "0.000000",
      relay_fee_usdt: "0.000000",
      refunded_usdt: "0.000000",
      net_usdt: "0.000000",
      status: "paid",
      tx_hash: e.txHash,
      block: String(e.blockNumber),
      log_index: String(e.logIndex),
    };
    if (e.type === "AgentTransfer") {
      const amount = BigInt(e.amount);
      if (amount <= 0n) throw new Error("Invalid agent transfer amount");
      row.source = "x402";
      row.gross_usdt = row.net_usdt = formatAmount(amount);
    } else {
      const key = `${e.merchantId}:${e.orderId}`;
      if (e.type === "Paid") {
        const paid = BigInt(e.value),
          fee = BigInt(e.fee);
        if (orders.has(key) || paid <= 0n || fee < 0n || fee > paid)
          throw new Error(`Invalid or duplicate payment ${key}`);
        row.gross_usdt = formatAmount(paid);
        row.relay_fee_usdt = formatAmount(fee);
        row.net_usdt = formatAmount(paid - fee);
        orders.set(key, {
          paid,
          fee,
          refunded: 0n,
          count: 0n,
          view: {
            orderId: e.orderId,
            merchantId: e.merchantId,
            payer: e.payer,
            payout: e.payout,
            gross: row.gross_usdt,
            fee: row.relay_fee_usdt,
            refunded: "0.000000",
            net: row.net_usdt,
            refundCount: 0,
            status: "paid",
            txHash: e.txHash,
            block: e.blockNumber,
            logIndex: e.logIndex,
          },
        });
      } else {
        const order = orders.get(key),
          amount = BigInt(e.amount),
          total = BigInt(e.totalRefunded);
        if (!order)
          throw new Error(
            `Refund has no payment history: ${key}. Check deploymentBlock.`,
          );
        if (
          e.payer !== order.view.payer ||
          amount <= 0n ||
          total !== order.refunded + amount ||
          total > order.paid ||
          BigInt(e.refundIndex) !== order.count
        )
          throw new Error(`Invalid refund history ${key}`);
        order.refunded = total;
        order.count++;
        row.refunded_usdt = formatAmount(amount);
        row.net_usdt = formatAmount(-amount);
        row.status = total === order.paid ? "refunded" : "partially_refunded";
        Object.assign(order.view, {
          refunded: formatAmount(total),
          net: formatAmount(order.paid - order.fee - total),
          refundCount: Number(order.count),
          status: row.status,
        });
      }
    }
    entries.push(row);
  }
  return { entries, orders: [...orders.values()].map((o) => o.view) };
}
