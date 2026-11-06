import { formatUsdt, type Order, type OrderStatus } from "@quietpay/shared";

export interface OrderRow {
  id: string;
  status: OrderStatus;
  amount: string;
  fee: string;
  payout: string;
  payer: string | null;
  explorerUrl: string | null;
  created: string;
  reference: string | null;
}

export const shortHex = (s: string) => `${s.slice(0, 6)}...${s.slice(-4)}`;

/** Returns the URL only when it parses as http(s); javascript:, data:, vbscript: etc. yield null. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export function toRow(o: Order): OrderRow {
  return {
    id: o.id,
    status: o.status,
    amount: `${formatUsdt(o.amount)} USDT`,
    fee: `${formatUsdt(o.fee)} USDT`,
    payout: o.payout,
    payer: o.payer ?? null,
    explorerUrl: safeHttpUrl(o.explorerUrl),
    created: new Date(o.createdAt * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC",
    reference: o.reference ?? null,
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
