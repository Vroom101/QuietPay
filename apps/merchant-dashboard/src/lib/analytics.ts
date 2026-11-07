/** Pure analytics maths for the Analytics view. All money is bigint USDT base units (6 decimals). */
import type { DashboardOrder } from "./view";
import { summarize, type SubscriptionView } from "./subscriptions";
import type { AgentPayment } from "./ledger-csv";

const PAID = new Set(["settled", "partially_refunded", "refunded"]);
export const isPaid = (o: DashboardOrder) => PAID.has(o.status);
export const refundedOf = (o: DashboardOrder): bigint => BigInt(o.refunded ?? (o.status === "refunded" ? o.amount : "0"));
export const netOf = (o: DashboardOrder): bigint => BigInt(o.amount) - BigInt(o.fee) - refundedOf(o);
const paidAt = (o: DashboardOrder) => o.settledAt ?? o.createdAt;
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** Percentage with one decimal from two bigints, 0 when the denominator is 0. */
export function pctOf(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Number((part * 1000n) / whole) / 10;
}

// ---------- a. growth ----------

export type Change = { kind: "none" } | { kind: "new" } | { kind: "flat" } | { kind: "pct"; pct: number };

/** current vs previous. previous === null means there is no comparison period (all time). */
export function compare(current: bigint, previous: bigint | null): Change {
  if (previous === null) return { kind: "none" };
  if (previous === 0n) return current === 0n ? { kind: "flat" } : { kind: "new" };
  const abs = previous < 0n ? -previous : previous;
  const pct = Number(((current - previous) * 10000n) / abs) / 100;
  return pct === 0 ? { kind: "flat" } : { kind: "pct", pct };
}

export function changeLabel(c: Change): string {
  switch (c.kind) {
    case "none": return "";
    case "new": return "new";
    case "flat": return "no change";
    case "pct": return `${c.pct > 0 ? "▲" : "▼"} ${Math.abs(c.pct).toFixed(1)}%`;
  }
}

/** Splits orders into the selected period and the previous equal-length one. range is "all" or a day count. */
export function splitPeriods(orders: DashboardOrder[], range: string, nowSec: number): { current: DashboardOrder[]; previous: DashboardOrder[] | null; sinceSec: number | null } {
  const days = Number(range);
  if (range === "all" || !Number.isFinite(days) || days <= 0) return { current: orders, previous: null, sinceSec: null };
  const start = nowSec - days * 86400;
  return {
    current: orders.filter((o) => o.createdAt >= start),
    previous: orders.filter((o) => o.createdAt >= start - days * 86400 && o.createdAt < start),
    sinceSec: start,
  };
}

export interface PeriodTotals { net: bigint; paid: number; aov: bigint }
export function totals(orders: DashboardOrder[]): PeriodTotals {
  const paid = orders.filter(isPaid);
  const gross = sum(paid.map((o) => BigInt(o.amount)));
  return { net: sum(paid.map(netOf)), paid: paid.length, aov: paid.length ? gross / BigInt(paid.length) : 0n };
}

export interface Growth {
  net: { current: bigint; previous: bigint | null; change: Change };
  paid: { current: number; previous: number | null; change: Change };
  aov: { current: bigint; previous: bigint | null; change: Change };
}
export function growth(current: DashboardOrder[], previous: DashboardOrder[] | null): Growth {
  const c = totals(current);
  const p = previous ? totals(previous) : null;
  return {
    net: { current: c.net, previous: p ? p.net : null, change: compare(c.net, p ? p.net : null) },
    paid: { current: c.paid, previous: p ? p.paid : null, change: compare(BigInt(c.paid), p ? BigInt(p.paid) : null) },
    aov: { current: c.aov, previous: p ? p.aov : null, change: compare(c.aov, p ? p.aov : null) },
  };
}

// ---------- b. revenue mix ----------

export const isSubscriptionOrder = (o: DashboardOrder) => (o.reference ?? "").startsWith("sub:");

/** Agent (x402) payments whose ledger timestamp ("YYYY-MM-DD HH:MM:SS", UTC) falls on/after sinceSec. */
export function agentInPeriod(payments: AgentPayment[], sinceSec: number | null): AgentPayment[] {
  if (sinceSec === null) return payments;
  return payments.filter((p) => {
    const t = Date.parse(p.date.trim().replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(p.date.trim()) ? "" : "Z"));
    return Number.isFinite(t) && t / 1000 >= sinceSec;
  });
}

export interface MixSegment { key: "checkout" | "subscription" | "agent"; label: string; amount: bigint; count: number; sharePct: number }
export interface Mix { total: bigint; segments: MixSegment[] }
/** Gross paid amounts split by source. agent === null means the ledger is not loaded: the agent segment is omitted. */
export function revenueMix(orders: DashboardOrder[], agent: AgentPayment[] | null): Mix {
  const paid = orders.filter(isPaid);
  const subs = paid.filter(isSubscriptionOrder);
  const one = paid.filter((o) => !isSubscriptionOrder(o));
  const raw: Omit<MixSegment, "sharePct">[] = [
    { key: "checkout", label: "One-time checkout", amount: sum(one.map((o) => BigInt(o.amount))), count: one.length },
    { key: "subscription", label: "Subscription renewals", amount: sum(subs.map((o) => BigInt(o.amount))), count: subs.length },
    ...(agent ? [{ key: "agent" as const, label: "AI agents (x402)", amount: sum(agent.map((p) => p.grossBase)), count: agent.length }] : []),
  ];
  const total = sum(raw.map((s) => s.amount));
  return { total, segments: raw.map((s) => ({ ...s, sharePct: pctOf(s.amount, total) })) };
}

// ---------- c. customers ----------

export interface TopCustomer { address: string; orders: number; spend: bigint }
export interface Customers {
  unique: number;
  repeat: number;
  repeatRatePct: number;
  repeatRevenue: bigint;
  repeatRevenuePct: number;
  top: TopCustomer[];
}
export function customers(orders: DashboardOrder[], limit = 5): Customers {
  const paid = orders.filter(isPaid);
  const by = new Map<string, TopCustomer>();
  for (const o of paid) {
    if (!o.payer) continue;
    const key = o.payer.toLowerCase();
    const c = by.get(key) ?? { address: o.payer, orders: 0, spend: 0n };
    c.orders++;
    c.spend += netOf(o);
    by.set(key, c);
  }
  const all = [...by.values()];
  const repeaters = all.filter((c) => c.orders >= 2);
  const repeatRevenue = sum(repeaters.map((c) => c.spend));
  const total = sum(paid.map(netOf));
  const top = [...all].sort((a, b) => (a.spend === b.spend ? 0 : a.spend > b.spend ? -1 : 1) || b.orders - a.orders || a.address.toLowerCase().localeCompare(b.address.toLowerCase())).slice(0, limit);
  return {
    unique: all.length,
    repeat: repeaters.length,
    repeatRatePct: all.length ? Math.round((1000 * repeaters.length) / all.length) / 10 : 0,
    repeatRevenue,
    repeatRevenuePct: total > 0n ? pctOf(repeatRevenue, total) : 0,
    top,
  };
}

// ---------- d. funnel ----------

export interface Funnel {
  created: number; paid: number; kept: number; abandoned: number; failed: number; open: number;
  conversionPct: number | null; keptPct: number | null;
}
export function funnel(orders: DashboardOrder[]): Funnel {
  const paid = orders.filter(isPaid);
  const kept = paid.filter((o) => refundedOf(o) < BigInt(o.amount));
  const created = orders.length;
  return {
    created,
    paid: paid.length,
    kept: kept.length,
    abandoned: orders.filter((o) => o.status === "expired").length,
    failed: orders.filter((o) => o.status === "failed").length,
    open: orders.filter((o) => o.status === "created" || o.status === "pending").length,
    conversionPct: created ? Math.round((1000 * paid.length) / created) / 10 : null,
    keptPct: paid.length ? Math.round((1000 * kept.length) / paid.length) / 10 : null,
  };
}

// ---------- e. refunds ----------

export interface RefundStats { paid: number; refundedOrders: number; ratePct: number | null; refunded: bigint; gross: bigint; refundedPctOfGross: number; feeLost: bigint }
export function refundStats(orders: DashboardOrder[]): RefundStats {
  const paid = orders.filter(isPaid);
  const gross = sum(paid.map((o) => BigInt(o.amount)));
  const refunded = sum(paid.map(refundedOf));
  const withRefund = paid.filter((o) => refundedOf(o) > 0n);
  const full = paid.filter((o) => refundedOf(o) >= BigInt(o.amount));
  return {
    paid: paid.length,
    refundedOrders: withRefund.length,
    ratePct: paid.length ? Math.round((1000 * withRefund.length) / paid.length) / 10 : null,
    refunded,
    gross,
    refundedPctOfGross: pctOf(refunded, gross),
    feeLost: sum(full.map((o) => BigInt(o.fee))),
  };
}

// ---------- f. speed ----------

/** Nearest-rank percentile (p in 0..100) of a numeric list; undefined when empty. Median uses the mean of the middle pair for even counts. */
export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  if (p === 50) {
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1]! + s[mid]!) / 2;
  }
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export interface Speed { count: number; median?: number; p90?: number }
export function speed(orders: DashboardOrder[]): Speed {
  const d = orders.filter((o) => isPaid(o) && o.settledAt !== undefined && o.settledAt >= o.createdAt).map((o) => o.settledAt! - o.createdAt);
  return { count: d.length, median: percentile(d, 50), p90: percentile(d, 90) };
}

// ---------- g. heatmap ----------

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export interface Heatmap { cells: number[][]; max: number; total: number; busiest: { day: (typeof WEEKDAYS)[number]; hour: number; count: number } | null }
/** cells[row][hour], row 0 = Monday ... 6 = Sunday, all in UTC, bucketed by settlement time (creation time if unknown). */
export function heatmap(orders: DashboardOrder[]): Heatmap {
  const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let total = 0;
  for (const o of orders) {
    if (!isPaid(o)) continue;
    const d = new Date(paidAt(o) * 1000);
    cells[(d.getUTCDay() + 6) % 7]![d.getUTCHours()]!++;
    total++;
  }
  let best: Heatmap["busiest"] = null;
  cells.forEach((row, r) => row.forEach((count, hour) => {
    if (count > 0 && (!best || count > best.count)) best = { day: WEEKDAYS[r]!, hour, count };
  }));
  return { cells, max: best ? (best as NonNullable<Heatmap["busiest"]>).count : 0, total, busiest: best };
}

// ---------- h. unit economics ----------

export interface UnitEconomics { paid: number; avgFee: bigint; avgGasWei: bigint | null; feePctOfGross: number }
export function unitEconomics(orders: DashboardOrder[]): UnitEconomics {
  const paid = orders.filter(isPaid);
  const fees = sum(paid.map((o) => BigInt(o.fee)));
  const gross = sum(paid.map((o) => BigInt(o.amount)));
  const gassed = paid.filter((o) => o.gasWei !== undefined);
  return {
    paid: paid.length,
    avgFee: paid.length ? fees / BigInt(paid.length) : 0n,
    avgGasWei: gassed.length ? sum(gassed.map((o) => BigInt(o.gasWei!))) / BigInt(gassed.length) : null,
    feePctOfGross: pctOf(fees, gross),
  };
}

// ---------- i. subscriptions ----------

export interface SubStats { total: number; active: number; pastDue: number; cancelled: number; mrrBase: bigint; churnPct: number | null }
export function subscriptionStats(subs: Pick<SubscriptionView, "status" | "plan">[]): SubStats {
  const { active, mrrBase } = summarize(subs);
  const cancelled = subs.filter((s) => s.status === "cancelled").length;
  return {
    total: subs.length,
    active,
    pastDue: subs.filter((s) => s.status === "past_due").length,
    cancelled,
    mrrBase,
    churnPct: subs.length ? Math.round((1000 * cancelled) / subs.length) / 10 : null,
  };
}
