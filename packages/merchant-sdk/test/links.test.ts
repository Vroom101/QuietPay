import { describe, expect, it } from "vitest";
import { makeOrder } from "@quietpay/shared/fixtures";
import { signWebhook } from "@quietpay/shared/webhook";
import { createQuietPay, memoryPaymentLinkStore, QuietpayConfigError, type PaymentLink, type QuietPayConfig } from "../src/index.js";

const MERCHANT = ("0x" + "1d".repeat(32)) as `0x${string}`;
const OTHER = ("0x" + "2e".repeat(32)) as `0x${string}`;
const T0 = 1_800_000_000;
const SECRET = "s".repeat(32);

function relayer() {
  const orders = new Map<string, ReturnType<typeof makeOrder>>();
  const created: { amount: string; reference?: string; expiresInSeconds?: number; webhookUrl?: string }[] = [];
  let n = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (init?.method === "POST" && u.pathname === "/v1/orders") {
      const body = JSON.parse(String(init.body));
      created.push(body);
      await new Promise((r) => setTimeout(r, 1)); // yield so concurrent calls interleave
      const id = ("0x" + (++n).toString(16).padStart(64, "0")) as `0x${string}`;
      const o = makeOrder({ id, merchantId: MERCHANT, amount: body.amount, reference: body.reference, status: "created" });
      orders.set(id, o);
      return Response.json(o);
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, created };
}

function client(over: Partial<QuietPayConfig> = {}) {
  const r = relayer();
  let t = T0;
  const qp = createQuietPay({ baseUrl: "http://relayer.test", apiKey: "k", merchantId: MERCHANT, webhookSecret: SECRET, webhookUrl: "https://shop.test/hook", fetch: r.f, now: () => t, ...over });
  return { qp, r, at: (s: number) => (t = s) };
}

const settled = (orderId: string, amount: string, reference: string, merchantId = MERCHANT, type: "payment.settled" | "payment.failed" = "payment.settled") => ({
  id: "evt_" + orderId.slice(-8), type, createdAt: T0 + 60,
  data: { orderId: orderId as `0x${string}`, merchantId, amount, fee: "50000" as const, payout: ("0x" + "22".repeat(20)) as `0x${string}`, reference },
});

describe("payment links: create", () => {
  it("creates with defaults and validates input", async () => {
    const { qp } = client();
    const l = await qp.links.create({ title: " Tip jar ", amount: "5000000" });
    expect(l).toMatchObject({ title: "Tip jar", amount: "5000000", singleUse: true, status: "active", paidCount: 0, orderIds: [], paidOrderIds: [], createdAt: T0 });
    expect(l.id).toMatch(/^link_[0-9a-f]{24}$/);
    expect(l.expiresAt).toBeUndefined();
    expect(await qp.links.get(l.id)).toEqual(l);
    expect(await qp.links.get("nope")).toBeUndefined();
    await expect(qp.links.create({ title: "", amount: "1" })).rejects.toThrow(/title/);
    await expect(qp.links.create({ title: "x".repeat(81), amount: "1" })).rejects.toThrow(/title/);
    await expect(qp.links.create({ title: "x", amount: "0" })).rejects.toThrow(/amount/);
    await expect(qp.links.create({ title: "x", amount: "1.5" })).rejects.toThrow(/amount/);
    await expect(qp.links.create({ title: "x", amount: "1", description: "d".repeat(281) })).rejects.toThrow(/description/);
    await expect(qp.links.create({ title: "x", amount: "1", id: "bad id!" })).rejects.toThrow(/id/);
    await expect(qp.links.create({ title: "x", amount: "1", expiresInSeconds: 59 })).rejects.toThrow(/expiresInSeconds/);
    await expect(qp.links.create({ title: "x", amount: "1", expiresInSeconds: 90 * 86400 + 1 })).rejects.toThrow(/expiresInSeconds/);
    const ok = await qp.links.create({ title: "x", amount: "1", expiresInSeconds: 90 * 86400, description: "d".repeat(280), id: "mine" });
    expect(ok.expiresAt).toBe(T0 + 90 * 86400);
    await expect(qp.links.create({ title: "x", amount: "1", id: "mine" })).rejects.toThrow(/already exists/);
  });

  it("refuses when one-time billing is off", async () => {
    const { qp } = client({ billing: "subscription" });
    await expect(qp.links.create({ title: "x", amount: "1" })).rejects.toBeInstanceOf(QuietpayConfigError);
    await expect(qp.links.checkout("a")).rejects.toBeInstanceOf(QuietpayConfigError);
    for (const b of ["both", "product", "one_time"] as const) {
      await expect(client({ billing: b }).qp.links.create({ title: "x", amount: "1" })).resolves.toBeTruthy();
    }
  });

  it("lists newest first", async () => {
    const { qp, at } = client();
    await qp.links.create({ title: "a", amount: "1", id: "a" });
    at(T0 + 10);
    await qp.links.create({ title: "b", amount: "1", id: "b" });
    expect((await qp.links.list()).map((l) => l.id)).toEqual(["b", "a"]);
  });

  it("rejects a bad linkCheckoutExpiresInSeconds", () => {
    expect(() => createQuietPay({ baseUrl: "x", apiKey: "k", merchantId: MERCHANT, linkCheckoutExpiresInSeconds: 59 })).toThrow(QuietpayConfigError);
    expect(() => createQuietPay({ baseUrl: "x", apiKey: "k", merchantId: MERCHANT, linkCheckoutExpiresInSeconds: 86401 })).toThrow(QuietpayConfigError);
  });
});

describe("payment links: checkout", () => {
  it("creates numbered orders with the right parameters", async () => {
    const { qp, r } = client({ billing: "both" });
    const l = await qp.links.create({ title: "x", amount: "7000000", id: "l1", singleUse: false });
    const a = await qp.links.checkout("l1");
    const b = await qp.links.checkout("l1");
    expect(r.created[0]).toMatchObject({ amount: "7000000", reference: "link:l1:1", expiresInSeconds: 1800, webhookUrl: "https://shop.test/hook" });
    expect(r.created[1]!.reference).toBe("link:l1:2");
    expect(b.link.orderIds).toEqual([a.order.id, b.order.id]);
    expect((await qp.links.get(l.id))!.orderIds).toHaveLength(2);
  });

  it("honours linkCheckoutExpiresInSeconds and keeps only the last 50 order ids", async () => {
    const { qp, r } = client({ linkCheckoutExpiresInSeconds: 600 });
    await qp.links.create({ title: "x", amount: "1", id: "l", singleUse: false });
    for (let i = 0; i < 52; i++) await qp.links.checkout("l");
    expect(r.created[0]!.expiresInSeconds).toBe(600);
    expect((await qp.links.get("l"))!.orderIds).toHaveLength(50);
  });

  it("refuses unknown, deactivated, paid and expired links without creating orders", async () => {
    const { qp, r, at } = client();
    await expect(qp.links.checkout("ghost")).rejects.toThrow(/Unknown payment link/);
    await qp.links.create({ title: "x", amount: "1", id: "d" });
    await qp.links.deactivate("d");
    expect((await qp.links.get("d"))!.status).toBe("deactivated");
    await expect(qp.links.checkout("d")).rejects.toThrow(/deactivated/);

    await qp.links.create({ title: "x", amount: "5", id: "p" });
    const { order } = await qp.links.checkout("p");
    await qp.links.applyWebhook(settled(order.id, "5", "link:p:1"));
    await expect(qp.links.checkout("p")).rejects.toThrow(/already been paid/);

    await qp.links.create({ title: "x", amount: "1", id: "e", expiresInSeconds: 100 });
    at(T0 + 99);
    await expect(qp.links.checkout("e")).resolves.toBeTruthy();
    at(T0 + 100);
    await expect(qp.links.checkout("e")).rejects.toThrow(/expired/);
    expect(r.created.map((c) => c.reference)).toEqual(["link:p:1", "link:e:1"]);
  });
});

describe("payment links: webhooks", () => {
  it("credits a single-use link once and closes it", async () => {
    const { qp } = client();
    await qp.links.create({ title: "x", amount: "5", id: "s" });
    const { order } = await qp.links.checkout("s");
    const l = await qp.links.applyWebhook(settled(order.id, "5", "link:s:1"));
    expect(l).toMatchObject({ status: "paid", paidCount: 1, paidOrderIds: [order.id], lastPaidOrderId: order.id, lastPaidAt: T0 + 60 });
  });

  it("a reusable link counts every payment and stays active", async () => {
    const { qp } = client();
    await qp.links.create({ title: "x", amount: "5", id: "r", singleUse: false });
    const a = await qp.links.checkout("r");
    const b = await qp.links.checkout("r");
    await qp.links.applyWebhook(settled(a.order.id, "5", "link:r:1"));
    const l = await qp.links.applyWebhook(settled(b.order.id, "5", "link:r:2"));
    expect(l).toMatchObject({ status: "active", paidCount: 2, paidOrderIds: [a.order.id, b.order.id] });
    expect(l!.duplicatePayments).toBeUndefined();
  });

  it("records a second payment on a paid single-use link as a duplicate, not a sale", async () => {
    const { qp } = client();
    await qp.links.create({ title: "x", amount: "5", id: "s" });
    const a = await qp.links.checkout("s");
    const b = await qp.links.checkout("s"); // both opened while still active
    await qp.links.applyWebhook(settled(a.order.id, "5", "link:s:1"));
    const l = await qp.links.applyWebhook(settled(b.order.id, "5", "link:s:2"));
    expect(l).toMatchObject({ status: "paid", paidCount: 1, paidOrderIds: [a.order.id], duplicatePayments: [b.order.id] });
    expect(await qp.links.applyWebhook(settled(b.order.id, "5", "link:s:2"))).toBeUndefined(); // duplicate replay
  });

  it("ignores forged events: unknown order, wrong amount, other merchant, failed, bad reference", async () => {
    const { qp } = client();
    await qp.links.create({ title: "x", amount: "5", id: "s", singleUse: false });
    const { order } = await qp.links.checkout("s");
    const other = "0x" + "ab".repeat(32);
    expect(await qp.links.applyWebhook(settled(other, "5", "link:s:1"))).toBeUndefined();
    expect(await qp.links.applyWebhook(settled(order.id, "4", "link:s:1"))).toBeUndefined();
    expect(await qp.links.applyWebhook(settled(order.id, "5", "link:s:1", OTHER))).toBeUndefined();
    expect(await qp.links.applyWebhook(settled(order.id, "5", "link:s:1", MERCHANT, "payment.failed"))).toBeUndefined();
    expect(await qp.links.applyWebhook(settled(order.id, "5", "link:zzz:1"))).toBeUndefined();
    expect(await qp.links.applyWebhook(settled(order.id, "5", "sub:s:1"))).toBeUndefined();
    expect((await qp.links.get("s"))!.paidCount).toBe(0);
  });

  it("ignores a replay of a credited order", async () => {
    const { qp } = client();
    await qp.links.create({ title: "x", amount: "5", id: "r", singleUse: false });
    const { order } = await qp.links.checkout("r");
    expect(await qp.links.applyWebhook(settled(order.id, "5", "link:r:1"))).toBeTruthy();
    expect(await qp.links.applyWebhook(settled(order.id, "5", "link:r:1"))).toBeUndefined();
    expect((await qp.links.get("r"))!.paidCount).toBe(1);
  });

  it("still credits an order issued before deactivation", async () => {
    const { qp } = client();
    await qp.links.create({ title: "x", amount: "5", id: "r", singleUse: false });
    const { order } = await qp.links.checkout("r");
    await qp.links.deactivate("r");
    const l = await qp.links.applyWebhook(settled(order.id, "5", "link:r:1"));
    expect(l).toMatchObject({ status: "deactivated", paidCount: 1 });
  });

  it("handleWebhook verifies the signature and applies to links and subscriptions", async () => {
    const { qp } = client({ billing: "both" });
    await qp.links.create({ title: "x", amount: "5", id: "s" });
    const { order } = await qp.links.checkout("s");
    const event = settled(order.id, "5", "link:s:1");
    const body = JSON.stringify(event);
    const sig = signWebhook(SECRET, body, T0 + 60);
    const out = await qp.links.handleWebhook({ body, signatureHeader: sig, nowSeconds: T0 + 60 });
    expect(out.link).toMatchObject({ id: "s", paidCount: 1 });
    expect(out.subscription).toBeUndefined();
    expect(out.event.id).toBe(event.id);
    await expect(qp.links.handleWebhook({ body, signatureHeader: "t=1,v1=00", nowSeconds: T0 + 60 })).rejects.toThrow();
    // subscriptions.handleWebhook stays backward compatible
    const sub = await qp.subscriptions.handleWebhook({ body, signatureHeader: sig, nowSeconds: T0 + 60 });
    expect(Object.keys(sub).sort()).toEqual(["event", "subscription"]);
  });
});

describe("payment links: concurrency and stores", () => {
  it("concurrent checkouts are serialised: both recorded, distinct references", async () => {
    const { qp, r } = client();
    await qp.links.create({ title: "x", amount: "1", id: "c", singleUse: false });
    const [a, b] = await Promise.all([qp.links.checkout("c"), qp.links.checkout("c")]);
    expect(a.order.id).not.toBe(b.order.id);
    expect(new Set(r.created.map((c) => c.reference))).toEqual(new Set(["link:c:1", "link:c:2"]));
    expect((await qp.links.get("c"))!.orderIds.sort()).toEqual([a.order.id, b.order.id].sort());
  });

  it("uses compareAndSetLink when present and retries on conflict", async () => {
    const base = memoryPaymentLinkStore();
    let calls = 0;
    let failOnce = true;
    const store = {
      ...base,
      compareAndSetLink: async (prev: PaymentLink, next: PaymentLink) => {
        calls++;
        if (failOnce) { failOnce = false; return false; }
        expect(await base.getLink(prev.id)).toEqual(prev);
        await base.putLink(next);
        return true;
      },
    };
    const { qp } = client({ paymentLinkStore: store });
    await qp.links.create({ title: "x", amount: "1", id: "k" });
    await qp.links.checkout("k");
    expect(calls).toBe(2);
    expect((await qp.links.get("k"))!.orderIds).toHaveLength(1);
  });

  it("memory store returns copies", async () => {
    const s = memoryPaymentLinkStore();
    const l: PaymentLink = { id: "a", title: "t", amount: "1", singleUse: true, status: "active", paidCount: 0, createdAt: 1, orderIds: [], paidOrderIds: [] };
    await s.putLink(l);
    (await s.getLink("a"))!.orderIds.push("x");
    expect((await s.getLink("a"))!.orderIds).toEqual([]);
  });
});

describe("payment links: reserved reference prefix", () => {
  it("createOrder cannot borrow a link: reference", () => {
    const { qp } = client();
    expect(() => qp.createOrder({ amount: "1", reference: "link:abc:1" })).toThrow(/reserved/);
  });
});
