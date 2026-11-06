import { describe, expect, it } from "vitest";
import { makeOrder } from "@quietpay/shared/fixtures";
import { signWebhook } from "@quietpay/shared/webhook";
import { addInterval, createQuietPay, QuietpayConfigError, type QuietPayConfig } from "../src/index.js";

const MERCHANT = ("0x" + "1d".repeat(32)) as `0x${string}`;
const T0 = Date.UTC(2026, 0, 31, 12) / 1000; // Jan 31: month-end clamping matters

function relayer() {
  const orders = new Map<string, ReturnType<typeof makeOrder>>();
  const created: { amount: string; reference?: string; expiresInSeconds?: number }[] = [];
  let n = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (init?.method === "POST" && u.pathname === "/v1/orders") {
      const body = JSON.parse(String(init.body));
      created.push(body);
      const id = ("0x" + (++n).toString(16).padStart(64, "0")) as `0x${string}`;
      const o = makeOrder({ id, merchantId: MERCHANT, amount: body.amount, reference: body.reference, status: "created" });
      orders.set(id, o);
      return Response.json(o);
    }
    const m = u.pathname.match(/^\/v1\/orders\/(0x[0-9a-f]{64})$/);
    if (m) return Response.json(orders.get(m[1]!));
    if (u.pathname === "/v1/orders") return Response.json({ orders: [...orders.values()] });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, orders, created };
}

function client(over: Partial<QuietPayConfig> = {}) {
  const r = relayer();
  let t = T0;
  const qp = createQuietPay({ baseUrl: "http://relayer.test", apiKey: "k", merchantId: MERCHANT, webhookSecret: "s".repeat(32), fetch: r.f, now: () => t, ...over });
  return { qp, r, at: (s: number) => (t = s) };
}

const settled = (orderId: string, amount: string, reference: string, type: "payment.settled" | "payment.failed" = "payment.settled") => ({
  id: "evt_" + orderId.slice(-8), type, createdAt: T0 + 60,
  data: { orderId: orderId as `0x${string}`, merchantId: MERCHANT, amount, fee: "50000" as const, payout: ("0x" + "22".repeat(20)) as `0x${string}`, reference },
});

describe("Feature: choose the billing model when the SDK is initialised", () => {
  it("defaults to one-time payments and refuses subscription calls", async () => {
    const { qp } = client();
    expect(qp.billing).toBe("one_time");
    expect(qp.supports).toEqual({ oneTime: true, subscription: false });
    await expect(qp.subscriptions.createPlan({ name: "Pro", amount: "5000000", interval: "month" })).rejects.toBeInstanceOf(QuietpayConfigError);
    expect((await qp.createOrder({ amount: "8500000" })).amount).toBe("8500000");
  });

  it("'product' is accepted as the name for one-time payments", async () => {
    const { qp } = client({ billing: "product" });
    expect(qp.billing).toBe("one_time");
    expect(qp.supports).toEqual({ oneTime: true, subscription: false });
  });

  it("subscription-only refuses one-time checkouts (no stray orders)", async () => {
    const { qp, r } = client({ billing: "subscription" });
    expect(() => qp.createOrder({ amount: "1" })).toThrow(/One-time payments is turned off/);
    expect(r.created).toHaveLength(0);
  });

  it("rejects an unknown billing mode and bad config up front", () => {
    expect(() => createQuietPay({ baseUrl: "x", apiKey: "k", merchantId: MERCHANT, billing: "monthly" as never })).toThrow(QuietpayConfigError);
    expect(() => createQuietPay({ baseUrl: "x", apiKey: "k", merchantId: "0x12" as never })).toThrow(/merchantId/);
    expect(() => createQuietPay({ baseUrl: "x", apiKey: "", merchantId: MERCHANT })).toThrow(/apiKey/);
  });

  it("'both' allows each, and one-time orders cannot borrow the reserved sub: reference", async () => {
    const { qp } = client({ billing: "both" });
    expect(qp.supports).toEqual({ oneTime: true, subscription: true });
    expect(() => qp.createOrder({ amount: "1", reference: "sub:sub_x:1" })).toThrow(/reserved/);
  });
});

describe("Feature: pay-per-period subscriptions over gasless USDT", () => {
  it("Scenario: subscribe, renew, pay, and the next renewal is due one month later", async () => {
    const { qp, r, at } = client({ billing: "subscription" });
    const plan = await qp.subscriptions.createPlan({ id: "pro", name: "Pro", amount: "5000000", interval: "month" });
    const sub = await qp.subscriptions.subscribe({ planId: plan.id, customer: "cust_42", id: "sub_1" });
    expect(await qp.subscriptions.due()).toHaveLength(1);

    const { order } = await qp.subscriptions.createRenewalOrder(sub.id);
    expect(r.created[0]).toMatchObject({ amount: "5000000", reference: "sub:sub_1:1", expiresInSeconds: 86400 });
    // idempotent while open
    expect((await qp.subscriptions.createRenewalOrder(sub.id)).order.id).toBe(order.id);
    expect(r.created).toHaveLength(1);
    expect(await qp.subscriptions.due()).toHaveLength(0);

    const paid = await qp.subscriptions.applyWebhook(settled(order.id, "5000000", "sub:sub_1:1"));
    expect(paid).toMatchObject({ status: "active", paidPeriods: 1, lastPaidOrderId: order.id, pendingOrderId: undefined });
    expect(paid!.nextChargeAt).toBe(Date.UTC(2026, 1, 28, 12) / 1000); // Jan 31 -> Feb 28
    await expect(qp.subscriptions.createRenewalOrder(sub.id)).rejects.toThrow(/not due until 2026-02-28/);

    at(paid!.nextChargeAt);
    const second = await qp.subscriptions.createRenewalOrder(sub.id);
    expect(r.created[1]!.reference).toBe("sub:sub_1:2");
    expect(second.order.id).not.toBe(order.id);
  });

  it("Scenario: a forged or mismatched webhook never marks a period paid", async () => {
    const { qp } = client({ billing: "subscription" });
    await qp.subscriptions.createPlan({ id: "pro", name: "Pro", amount: "5000000", interval: "month" });
    await qp.subscriptions.subscribe({ planId: "pro", customer: "c", id: "sub_1" });
    const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
    const other = "0x" + "ff".repeat(32);
    expect(await qp.subscriptions.applyWebhook(settled(other, "5000000", "sub:sub_1:1"))).toBeUndefined(); // another order with the reference
    expect(await qp.subscriptions.applyWebhook(settled(order.id, "1", "sub:sub_1:1"))).toBeUndefined(); // wrong amount
    expect(await qp.subscriptions.applyWebhook({ ...settled(order.id, "5000000", "sub:sub_1:1"), data: { ...settled(order.id, "5000000", "sub:sub_1:1").data, merchantId: ("0x" + "ab".repeat(32)) as `0x${string}` } })).toBeUndefined();
    expect((await qp.subscriptions.get("sub_1"))!.paidPeriods).toBe(0);
  });

  it("Scenario: handleWebhook verifies the signature first", async () => {
    const { qp } = client({ billing: "subscription" });
    await qp.subscriptions.createPlan({ id: "pro", name: "Pro", amount: "5000000", interval: "week" });
    await qp.subscriptions.subscribe({ planId: "pro", customer: "c", id: "sub_1" });
    const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
    const body = JSON.stringify(settled(order.id, "5000000", "sub:sub_1:1"));
    const nowS = Math.floor(Date.now() / 1000);
    await expect(qp.subscriptions.handleWebhook({ body, signatureHeader: signWebhook("wrong-secret-wrong-secret-wrong!", body, nowS) })).rejects.toThrow(/signature/i);
    const ok = await qp.subscriptions.handleWebhook({ body, signatureHeader: signWebhook("s".repeat(32), body, nowS) });
    expect(ok.subscription?.paidPeriods).toBe(1);
    expect(ok.subscription?.nextChargeAt).toBe(T0 + 7 * 86400);
  });

  it("Scenario: an unpaid renewal that expires makes the subscription past_due, and a new renewal can be created", async () => {
    const { qp, r } = client({ billing: "subscription" });
    await qp.subscriptions.createPlan({ id: "pro", name: "Pro", amount: "5000000", interval: "month" });
    await qp.subscriptions.subscribe({ planId: "pro", customer: "c", id: "sub_1" });
    const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
    r.orders.set(order.id, { ...r.orders.get(order.id)!, status: "expired" });
    const again = await qp.subscriptions.createRenewalOrder("sub_1");
    expect(again.subscription.status).toBe("past_due");
    expect(again.order.id).not.toBe(order.id);
    expect(r.created[1]!.reference).toBe("sub:sub_1:1"); // still period 1
  });

  it("Scenario: a missed webhook is recovered from the order itself", async () => {
    const { qp, r } = client({ billing: "subscription" });
    await qp.subscriptions.createPlan({ id: "pro", name: "Pro", amount: "5000000", interval: "month" });
    await qp.subscriptions.subscribe({ planId: "pro", customer: "c", id: "sub_1" });
    const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
    r.orders.set(order.id, { ...r.orders.get(order.id)!, status: "settled", settledAt: T0 + 5 });
    await expect(qp.subscriptions.createRenewalOrder("sub_1")).rejects.toThrow(/paid until/);
    expect((await qp.subscriptions.get("sub_1"))!.paidPeriods).toBe(1);
  });

  it("Scenario: cancel stops renewals", async () => {
    const { qp } = client({ billing: "subscription" });
    await qp.subscriptions.createPlan({ id: "pro", name: "Pro", amount: "5000000", interval: "year" });
    await qp.subscriptions.subscribe({ planId: "pro", customer: "c", id: "sub_1" });
    await qp.subscriptions.cancel("sub_1");
    await expect(qp.subscriptions.createRenewalOrder("sub_1")).rejects.toThrow(/cancelled/);
    expect(await qp.subscriptions.due()).toHaveLength(0);
  });

  it.each([
    [{ name: "", amount: "1", interval: "month" }, /name/],
    [{ name: "x", amount: "0", interval: "month" }, /amount/],
    [{ name: "x", amount: "1.5", interval: "month" }, /amount/],
    [{ name: "x", amount: "1", interval: "hour" }, /interval/],
    [{ name: "x", amount: "1", interval: "month", id: "bad id!" }, /plan id/],
    [{ name: "x", amount: "1", interval: "month", intervalCount: 0 }, /intervalCount/],
  ])("rejects an invalid plan %#", async (p, err) => {
    const { qp } = client({ billing: "subscription" });
    await expect(qp.subscriptions.createPlan(p as never)).rejects.toThrow(err);
  });
});

describe("Feature: subscription hardening (security review)", () => {
  const ev = settled;
  async function start(interval: "month" | "week" = "month", over: Partial<QuietPayConfig> = {}) {
    const c = client({ billing: "subscription", ...over });
    await c.qp.subscriptions.createPlan({ id: "pro", name: "Pro", amount: "5000000", interval });
    await c.qp.subscriptions.subscribe({ planId: "pro", customer: "c", id: "sub_1" });
    return c;
  }

  it("#1 a failed order that settles late still credits the period, and a second order cannot double charge", async () => {
    const { qp, r } = await start();
    const first = (await qp.subscriptions.createRenewalOrder("sub_1")).order;
    r.orders.set(first.id, { ...r.orders.get(first.id)!, status: "failed" });
    const failed = await qp.subscriptions.applyWebhook(ev(first.id, "5000000", "sub:sub_1:1", "payment.failed"));
    expect(failed).toMatchObject({ status: "past_due", pendingOrderId: undefined });
    const second = (await qp.subscriptions.createRenewalOrder("sub_1")).order;
    expect(second.id).not.toBe(first.id);
    expect(r.created[1]!.reference).toBe("sub:sub_1:1");
    // the failed one lands late: it credits period 1
    const paid = await qp.subscriptions.applyWebhook(ev(first.id, "5000000", "sub:sub_1:1"));
    expect(paid).toMatchObject({ status: "active", paidPeriods: 1, lastPaidOrderId: first.id });
    // the replacement order settles too: not credited again, flagged for refund
    const dup = await qp.subscriptions.applyWebhook(ev(second.id, "5000000", "sub:sub_1:1"));
    expect(dup).toMatchObject({ paidPeriods: 1 });
    expect(dup!.duplicatePayments).toEqual([{ orderId: second.id, amount: "5000000", at: T0 + 60 }]);
    // replaying the credited webhook changes nothing
    expect(await qp.subscriptions.applyWebhook(ev(first.id, "5000000", "sub:sub_1:1"))).toBeUndefined();
    expect((await qp.subscriptions.get("sub_1"))!.paidPeriods).toBe(1);
  });

  it("#1 an expired order that settles late credits the period (via sweep) once", async () => {
    const { qp, r, at } = await start();
    const first = (await qp.subscriptions.createRenewalOrder("sub_1")).order;
    r.orders.set(first.id, { ...r.orders.get(first.id)!, status: "expired" });
    await qp.subscriptions.sweep();
    expect((await qp.subscriptions.get("sub_1"))!.status).toBe("past_due");
    const second = (await qp.subscriptions.createRenewalOrder("sub_1")).order;
    r.orders.set(first.id, { ...r.orders.get(first.id)!, status: "settled", settledAt: T0 + 90 });
    at(T0 + 100);
    const [s] = await qp.subscriptions.sweep();
    expect(s).toMatchObject({ status: "active", paidPeriods: 1, lastPaidOrderId: first.id });
    expect(second.id).not.toBe(first.id);
  });

  it("#1 a bounded number of orders per period", async () => {
    const { qp, r } = await start();
    for (let i = 0; i < 20; i++) {
      const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
      r.orders.set(order.id, { ...r.orders.get(order.id)!, status: "expired" });
    }
    await expect(qp.subscriptions.createRenewalOrder("sub_1")).rejects.toThrow(/too many/);
    expect((await qp.subscriptions.get("sub_1"))!.periodOrders).toHaveLength(20);
  });

  it("#2 concurrent createRenewalOrder makes one order; concurrent settle webhooks credit once", async () => {
    const { qp, r } = await start();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => qp.subscriptions.createRenewalOrder("sub_1")));
    expect(r.created).toHaveLength(1);
    expect(a.order.id).toBe(b.order.id);
    expect(c.order.id).toBe(a.order.id);
    await Promise.all([1, 2].map(() => qp.subscriptions.applyWebhook(ev(a.order.id, "5000000", "sub:sub_1:1"))));
    expect((await qp.subscriptions.get("sub_1"))!.paidPeriods).toBe(1);
  });

  it("#2 compareAndSetSubscription is used when the store has it, and a lost race is retried", async () => {
    const { memorySubscriptionStore } = await import("../src/index.js");
    const inner = memorySubscriptionStore();
    let calls = 0;
    let injected = false;
    const store = {
      ...inner,
      compareAndSetSubscription: async (prev: Parameters<typeof inner.putSubscription>[0], next: Parameters<typeof inner.putSubscription>[0]) => {
        calls++;
        if (!injected) { injected = true; return false; } // someone else wrote first
        await inner.putSubscription(next);
        return true;
      },
    };
    const { qp } = await start("month", { subscriptionStore: store, billing: "subscription" });
    const { subscription } = await qp.subscriptions.createRenewalOrder("sub_1");
    expect(calls).toBe(2);
    expect(subscription.pendingOrderId).toBeDefined();
    const cancelled = await qp.subscriptions.cancel("sub_1");
    expect(cancelled.status).toBe("cancelled");
  });

  it("#3 a subscription with an expired pending order is due again and sweep makes it past_due", async () => {
    const { qp, r, at } = await start();
    const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
    expect(await qp.subscriptions.due()).toHaveLength(0); // live order, nothing to do
    r.orders.set(order.id, { ...r.orders.get(order.id)!, status: "expired" });
    at(order.expiresAt + 1);
    expect((await qp.subscriptions.due()).map((s) => s.id)).toEqual(["sub_1"]);
    const [swept] = await qp.subscriptions.sweep();
    expect(swept).toMatchObject({ status: "past_due", pendingOrderId: undefined, periodOrders: [order.id] });
    expect((await qp.subscriptions.due()).map((s) => s.id)).toEqual(["sub_1"]);
  });

  it("#3 sweep credits a settled pending order whose webhook was missed", async () => {
    const { qp, r } = await start();
    const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
    r.orders.set(order.id, { ...r.orders.get(order.id)!, status: "settled", settledAt: T0 + 5 });
    await qp.subscriptions.sweep(T0 + 10);
    expect(await qp.subscriptions.get("sub_1")).toMatchObject({ status: "active", paidPeriods: 1, lastPaidOrderId: order.id });
  });

  it("#5 missed-webhook recovery refuses refunded orders, wrong amounts and wrong merchants", async () => {
    for (const patch of [{ status: "refunded" }, { status: "partially_refunded" }, { status: "settled", amount: "1" }, { status: "settled", merchantId: ("0x" + "ab".repeat(32)) as `0x${string}` }]) {
      const { qp, r } = await start();
      const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
      r.orders.set(order.id, { ...r.orders.get(order.id)!, settledAt: T0 + 5, ...patch } as never);
      await qp.subscriptions.createRenewalOrder("sub_1").catch(() => undefined);
      expect((await qp.subscriptions.get("sub_1"))!.paidPeriods).toBe(0);
    }
  });

  it("#5 an exact settled order (merchant compared case-insensitively) is still recovered", async () => {
    const { qp, r } = await start();
    const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
    r.orders.set(order.id, { ...r.orders.get(order.id)!, status: "settled", settledAt: T0 + 5, merchantId: MERCHANT.toUpperCase().replace("0X", "0x") as `0x${string}` });
    await expect(qp.subscriptions.createRenewalOrder("sub_1")).rejects.toThrow(/paid until/);
    expect((await qp.subscriptions.get("sub_1"))!.paidPeriods).toBe(1);
  });

  it("#6 the monthly billing day does not drift: Jan 31 -> Feb 28 -> Mar 31 -> Apr 30", async () => {
    const { qp, at } = await start();
    const due: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { order, subscription } = await qp.subscriptions.createRenewalOrder("sub_1");
      const paid = await qp.subscriptions.applyWebhook(ev(order.id, "5000000", `sub:sub_1:${subscription.paidPeriods + 1}`));
      due.push(paid!.nextChargeAt);
      at(paid!.nextChargeAt + 3600); // pays a bit late each time
    }
    expect(due).toEqual([Date.UTC(2026, 1, 28, 12), Date.UTC(2026, 2, 31, 12), Date.UTC(2026, 3, 30, 12)].map((x) => x / 1000));
  });

  it("compat: a subscription from an old store (no anchorAt/periodOrders) still works", async () => {
    const { memorySubscriptionStore } = await import("../src/index.js");
    const store = memorySubscriptionStore();
    const { qp } = await start("month", { subscriptionStore: store });
    const { order } = await qp.subscriptions.createRenewalOrder("sub_1");
    const old = (await store.getSubscription("sub_1"))!;
    delete old.anchorAt; delete old.periodOrders; delete old.pendingExpiresAt;
    await store.putSubscription(old);
    const paid = await qp.subscriptions.applyWebhook(ev(order.id, "5000000", "sub:sub_1:1"));
    expect(paid).toMatchObject({ paidPeriods: 1, nextChargeAt: Date.UTC(2026, 1, 28, 12) / 1000 });
  });
});

describe("addInterval", () => {
  it("clamps month ends and handles leap years", () => {
    expect(addInterval(Date.UTC(2028, 0, 31) / 1000, "month")).toBe(Date.UTC(2028, 1, 29) / 1000);
    expect(addInterval(Date.UTC(2028, 1, 29) / 1000, "year")).toBe(Date.UTC(2029, 1, 28) / 1000);
    expect(addInterval(Date.UTC(2026, 0, 15) / 1000, "month", 3)).toBe(Date.UTC(2026, 3, 15) / 1000);
    expect(addInterval(0, "day", 2)).toBe(172800);
  });
});
