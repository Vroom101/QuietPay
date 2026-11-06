import { formatUsdt, parseUsdt, token, type Order, type OrderStatus } from "@quietpay/shared";
import type { DemoOrder } from "../../../demo-store/src/billing";

export type DashboardOrder = Pick<Order, "id" | "status" | "amount" | "fee" | "createdAt" | "settledAt" | "refunded" | "refundCount" | "payer" | "reference" | "explorerUrl"> &
  Partial<Pick<Order, "checkout" | "payout">>;

export function demoOrderToDashboard(order: DemoOrder): DashboardOrder {
  const amount = parseUsdt(order.amount);
  const refunded = order.refunds.reduce((total, refund) => total + parseUsdt(refund.amount), 0n);
  const placedAt = Math.floor(order.placedAt / 1000);
  return {
    id: order.id, amount: amount.toString(), fee: "0", refunded: refunded.toString(),
    refundCount: order.refunds.length, createdAt: placedAt, settledAt: placedAt,
    status: refunded === 0n ? "settled" : refunded >= amount ? "refunded" : "partially_refunded",
  };
}

export interface OrderRow {
  id: string;
  status: OrderStatus;
  amount: string;
  fee: string;
  payout: string | null;
  payer: string | null;
  explorerUrl: string | null;
  created: string;
  reference: string | null;
  refund: { label: string; refunded: string; remaining: string; count?: number } | null;
}

export const shortHex = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`;

function formatRefundAmount(amount: bigint): string {
  const digits = amount.toString().padStart(token.decimals + 1, "0");
  const fraction = digits.slice(-token.decimals).replace(/0+$/, "").padEnd(2, "0");
  return `${digits.slice(0, -token.decimals)}.${fraction} USDT`;
}

function refundSummary(order: DashboardOrder): OrderRow["refund"] {
  if (!["settled", "partially_refunded", "refunded"].includes(order.status) || order.refunded === undefined) return null;
  const amount = BigInt(order.amount);
  const refunded = BigInt(order.refunded);
  if (refunded > amount) return null;

  let label = "No refund";
  if (refunded === amount) label = "Fully refunded";
  else if (refunded > 0n) label = "Partially refunded";
  return { label, refunded: formatRefundAmount(refunded), remaining: formatRefundAmount(amount - refunded), count: order.refundCount };
}

export function toRow(o: DashboardOrder): OrderRow {
  return {
    id: o.id,
    status: o.status,
    amount: `${formatUsdt(o.amount)} USDT`,
    fee: `${formatUsdt(o.fee)} USDT`,
    payout: o.payout ?? null,
    payer: o.payer ?? null,
    explorerUrl: o.explorerUrl ?? null,
    created: new Date(o.createdAt * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC",
    reference: o.reference ?? null,
    refund: refundSummary(o),
  };
}

export const STATUS_STYLES: Record<OrderStatus, string> = {
  created: "bg-stone-100 text-stone-700",
  pending: "bg-amber-100 text-amber-800",
  settled: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  partially_refunded: "bg-amber-100 text-amber-800",
  refunded: "bg-stone-200 text-stone-700",
  expired: "bg-stone-200 text-stone-500",
};
