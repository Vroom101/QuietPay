import { describe, expect, it } from "vitest";
import type { DashboardOrder } from "../src/lib/view";
import type { AgentPayment } from "../src/lib/ledger-csv";
import {
  agentInPeriod, changeLabel, compare, customers, funnel, growth, heatmap, percentile, refundStats, revenueMix, speed,
  splitPeriods, subscriptionStats, totals, unitEconomics,
} from "../src/lib/analytics";

const U = 1_000_000n;
let n = 0;
const order = (o: Partial<DashboardOrder> & { usdt?: number } = {}): DashboardOrder => {
  const { usdt, ...rest } = o;
  return { id: `o${n++}`, status: "settled", amount: String(BigInt(usdt ?? 10) * U), fee: "100000", createdAt: 1000, settledAt: 1010, ...rest } as DashboardOrder;
};
const A = "0x" + "aa".repeat(20), B = "0x" + "bb".repeat(20), C = "0x" + "cc".repeat(20);

describe("period comparison", () => {
  it("handles previous = 0, none and negatives", () => {
    expect(compare(5n, 0n)).toEqual({ kind: "new" });
    expect(compare(0n, 0n)).toEqual({ kind: "flat" });
    expect(compare(5n, null)).toEqual({ kind: "none" });
    expect(compare(150n, 100n)).toEqual({ kind: "pct", pct: 50 });
    expect(compare(50n, 100n)).toEqual({ kind: "pct", pct: -50 });
    expect(compare(100n, 100n)).toEqual({ kind: "flat" });
    expect(compare(-50n, -100n)).toEqual({ kind: "pct", pct: 50 });
  });
  it("labels changes", () => {
    expect(changeLabel({ kind: "pct", pct: 12.34 })).toBe("▲ 12.3%");
    expect(changeLabel({ kind: "pct", pct: -5 })).toBe("▼ 5.0%");
    expect(changeLabel({ kind: "new" })).toBe("new");
    expect(changeLabel({ kind: "none" })).toBe("");
  });
  it("splits into equal-length current and previous windows", () => {
    const now = 100 * 86400;
    const cur = order({ createdAt: now - 86400 }), prev = order({ createdAt: now - 8 * 86400 }), old = order({ createdAt: now - 20 * 86400 });
    const s = splitPeriods([cur, prev, old], "7", now);
    expect(s.current).toEqual([cur]);
    expect(s.previous).toEqual([prev]);
    expect(s.sinceSec).toBe(now - 7 * 86400);
    expect(splitPeriods([cur, prev], "all", now)).toEqual({ current: [cur, prev], previous: null, sinceSec: null });
  });
  it("computes growth from totals", () => {
    const cur = [order({ usdt: 20 }), order({ usdt: 10 })], prev = [order({ usdt: 10 })];
    expect(totals(cur)).toEqual({ net: 29_800_000n, paid: 2, aov: 15n * U });
    const g = growth(cur, prev);
    expect(g.paid.change).toEqual({ kind: "pct", pct: 100 });
    expect(g.aov.change).toEqual({ kind: "pct", pct: 50 });
    expect(growth(cur, []).net.change).toEqual({ kind: "new" });
    expect(growth(cur, null).net.change).toEqual({ kind: "none" });
  });
});

describe("revenue mix", () => {
  const agent = [{ grossBase: 5n * U }, { grossBase: 5n * U }] as AgentPayment[];
  it("splits one-time, sub: renewals and agents", () => {
    const m = revenueMix([order({ usdt: 20 }), order({ usdt: 10, reference: "sub:s1:2" }), order({ status: "failed", usdt: 99 })], agent);
    expect(m.total).toBe(40n * U);
    expect(m.segments.map((s) => [s.key, s.amount, s.count, s.sharePct])).toEqual([
      ["checkout", 20n * U, 1, 50], ["subscription", 10n * U, 1, 25], ["agent", 10n * U, 2, 25],
    ]);
  });
  it("omits agents when the ledger is not loaded and survives zero", () => {
    const m = revenueMix([], null);
    expect(m.segments.map((s) => s.key)).toEqual(["checkout", "subscription"]);
    expect(m.segments.every((s) => s.sharePct === 0)).toBe(true);
  });
  it("filters agent payments to the period in UTC", () => {
    const p = (date: string) => ({ date, grossBase: 1n }) as AgentPayment;
    const since = Date.UTC(2026, 0, 2) / 1000;
    expect(agentInPeriod([p("2026-01-01 23:59:59"), p("2026-01-02 00:00:00"), p("bad")], since)).toHaveLength(1);
    expect(agentInPeriod([p("bad")], null)).toHaveLength(1);
  });
});

describe("customers", () => {
  it("computes repeat rate, repeat revenue and ordered top list", () => {
    const os = [
      order({ payer: A, usdt: 10 }), order({ payer: A.toUpperCase().replace("0X", "0x"), usdt: 10 }),
      order({ payer: B, usdt: 19 }), order({ payer: C, usdt: 19 }), order({ payer: C, usdt: 1, status: "failed" }), order({ usdt: 5 }),
    ];
    const c = customers(os);
    expect(c.unique).toBe(3);
    expect(c.repeat).toBe(1);
    expect(c.repeatRatePct).toBe(33.3);
    expect(c.repeatRevenue).toBe(19_800_000n);
    expect(c.top.map((t) => t.address.toLowerCase())).toEqual([A, B, C]); // B and C tie on spend: address order
    expect(c.top[0]!.orders).toBe(2);
  });
  it("breaks spend ties by order count first, limits to 5 and handles none", () => {
    const tie = customers([order({ payer: B, usdt: 10 }), order({ payer: A, usdt: 5, fee: "50000" }), order({ payer: A, usdt: 5, fee: "50000" })]);
    expect(tie.top.map((t) => t.address)).toEqual([A, B]);
    const wallets = Array.from({ length: 7 }, (_, i) => "0x" + String(i).repeat(40));
    expect(customers(wallets.map((w) => order({ payer: w }))).top).toHaveLength(5);
    expect(customers([])).toMatchObject({ unique: 0, repeatRatePct: 0, repeatRevenuePct: 0, top: [] });
  });
});

describe("funnel and refunds", () => {
  const os = [
    order({}), order({ status: "refunded", refunded: String(10n * U) }), order({ status: "partially_refunded", refunded: String(2n * U) }),
    order({ status: "expired" }), order({ status: "failed" }), order({ status: "pending" }),
  ];
  it("counts the funnel", () => {
    expect(funnel(os)).toEqual({ created: 6, paid: 3, kept: 2, abandoned: 1, failed: 1, open: 1, conversionPct: 50, keptPct: 66.7 });
    expect(funnel([])).toMatchObject({ created: 0, conversionPct: null, keptPct: null });
  });
  it("computes refund rate, refunded share and fee lost on full refunds", () => {
    const r = refundStats(os);
    expect(r.ratePct).toBe(66.7);
    expect(r.refundedOrders).toBe(2);
    expect(r.refunded).toBe(12n * U);
    expect(r.refundedPctOfGross).toBe(40);
    expect(r.feeLost).toBe(100000n);
    expect(refundStats([])).toMatchObject({ ratePct: null, feeLost: 0n });
  });
});

describe("speed", () => {
  it("percentiles with odd and even counts", () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(percentile(Array.from({ length: 10 }, (_, i) => i + 1), 90)).toBe(9);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 50)).toBeUndefined();
  });
  it("uses only paid orders with a settlement time", () => {
    const s = speed([order({ createdAt: 0, settledAt: 12 }), order({ createdAt: 0, settledAt: 20 }), order({ status: "failed", settledAt: 1 }), order({ settledAt: undefined })]);
    expect(s).toEqual({ count: 2, median: 16, p90: 20 });
    expect(speed([])).toEqual({ count: 0, median: undefined, p90: undefined });
  });
});

describe("heatmap", () => {
  it("buckets by UTC weekday (Mon first) and hour", () => {
    const mon10 = Date.UTC(2026, 0, 5, 10, 30) / 1000; // Monday
    const sun23 = Date.UTC(2026, 0, 11, 23, 59) / 1000; // Sunday
    const h = heatmap([
      order({ settledAt: mon10 }), order({ settledAt: mon10 + 60 }), order({ settledAt: sun23 }),
      order({ settledAt: mon10, status: "failed" }), order({ settledAt: undefined, createdAt: sun23 }),
    ]);
    expect(h.cells[0]![10]).toBe(2);
    expect(h.cells[6]![23]).toBe(2);
    expect(h.total).toBe(4);
    expect(h.max).toBe(2);
    expect(h.busiest).toEqual({ day: "Mon", hour: 10, count: 2 });
  });
  it("is empty without paid orders", () => {
    expect(heatmap([order({ status: "created" })])).toMatchObject({ total: 0, max: 0, busiest: null });
  });
});

describe("unit economics", () => {
  it("averages fee and gas, ignoring orders without gasWei", () => {
    const u = unitEconomics([order({ gasWei: "100" }), order({ gasWei: "300" }), order({}), order({ status: "failed", gasWei: "9999" })]);
    expect(u.paid).toBe(3);
    expect(u.avgFee).toBe(100000n);
    expect(u.avgGasWei).toBe(200n);
    expect(u.feePctOfGross).toBe(1);
  });
  it("reports null gas when never reported and handles no orders", () => {
    expect(unitEconomics([order({})]).avgGasWei).toBeNull();
    expect(unitEconomics([])).toEqual({ paid: 0, avgFee: 0n, avgGasWei: null, feePctOfGross: 0 });
  });
});

describe("subscription stats", () => {
  const plan = (amountBase: string, interval = "month") => ({ id: "p", name: "P", amount: "", amountBase, interval, intervalCount: 1 }) as never;
  it("counts statuses, MRR and churn", () => {
    const s = subscriptionStats([
      { status: "active", plan: plan("5000000") }, { status: "active", plan: plan("12000000", "year") },
      { status: "past_due", plan: plan("5000000") }, { status: "cancelled", plan: plan("5000000") },
    ]);
    expect(s).toEqual({ total: 4, active: 2, pastDue: 1, cancelled: 1, mrrBase: 6_000_000n, churnPct: 25 });
    expect(subscriptionStats([]).churnPct).toBeNull();
  });
});
