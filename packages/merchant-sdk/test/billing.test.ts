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

describe("addInterval", () => {
  it("clamps month ends and handles leap years", () => {
    expect(addInterval(Date.UTC(2028, 0, 31) / 1000, "month")).toBe(Date.UTC(2028, 1, 29) / 1000);
    expect(addInterval(Date.UTC(2028, 1, 29) / 1000, "year")).toBe(Date.UTC(2029, 1, 28) / 1000);
    expect(addInterval(Date.UTC(2026, 0, 15) / 1000, "month", 3)).toBe(Date.UTC(2026, 3, 15) / 1000);
    expect(addInterval(0, "day", 2)).toBe(172800);
  });
});
