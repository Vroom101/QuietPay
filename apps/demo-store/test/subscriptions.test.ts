import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createMockRelayer } from "@quietpay/shared/mock-server";
import { merchantIdFromSlug, ORDER_TOKEN_HEADER } from "@quietpay/shared";
import { signWebhook } from "@quietpay/shared/webhook";
import * as sdk from "@quietpay/merchant-sdk";
import { buildApp, type StoreConfig } from "../server/app.js";

const SECRET = "test-secret";
const DASH = "dashboard-test-access-token-at-least-32-characters";
const merchantId = merchantIdFromSlug("demo-store");
const wallet = privateKeyToAccount(generatePrivateKey());
const auth = { authorization: `Bearer ${DASH}` };

let relayer: Server;
let apps: ReturnType<typeof buildApp>[] = [];
let dirs: string[] = [];
const relayerUrl = () => `http://127.0.0.1:${(relayer.address() as AddressInfo).port}`;

beforeEach(async () => {
  relayer = createMockRelayer({ settleAfterMs: 0 });
  await new Promise<void>((r) => relayer.listen(0, "127.0.0.1", r));
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await new Promise<void>((r) => relayer.close(() => r()));
});

function make(extra: Partial<StoreConfig> = {}) {
  // The mock relayer only settles after a relay call; webhook tests need the relayer to report the order as settled.
  const stub = { ...sdk, getOrder: async (o: Parameters<typeof sdk.getOrder>[0]) => ({ ...(await sdk.getOrder(o)), status: "settled" as const }) };
  const app = buildApp(stub, {
    baseUrl: relayerUrl(),
    apiKey: "k",
    merchantId,
    webhookSecret: SECRET,
    billing: "both",
    refunds: { dashboardToken: DASH, router: ("0x" + "22".repeat(20)) as `0x${string}`, refundSignerPrivateKey: ("0x" + "11".repeat(32)) as `0x${string}`, databasePath: ":memory:" },
    ...extra,
  });
  apps.push(app);
  return app;
}
const createPlan = (app: ReturnType<typeof buildApp>, payload: Record<string, unknown> = { name: "Pro", amount: "5.00", interval: "month" }) =>
  app.inject({ method: "POST", url: "/api/merchant/plans", headers: auth, payload: payload as never });
async function subscribed(app: ReturnType<typeof buildApp>, ip = "203.0.113.1") {
  const plan = (await createPlan(app)).json();
  const res = await app.inject({ method: "POST", url: `/api/plans/${plan.id}/subscribe`, payload: { consent: true }, remoteAddress: ip });
  return { plan, res, body: res.json() };
}
const webhook = (app: ReturnType<typeof buildApp>, over: { orderId: string; reference: string; amount?: string; id?: string; type?: string; merchant?: string }) => {
  const body = JSON.stringify({
    id: over.id ?? "evt_sub_" + Math.random().toString(16).slice(2, 12),
    type: over.type ?? "payment.settled",
    createdAt: Math.floor(Date.now() / 1000),
    data: {
      orderId: over.orderId,
      merchantId: over.merchant ?? merchantId,
      amount: over.amount ?? "5000000",
      fee: "50000",
      payout: "0x" + "33".repeat(20),
      reference: over.reference,
    },
  });
  return app.inject({ method: "POST", url: "/webhooks/quietpay", headers: { "content-type": "application/json", "quietpay-signature": signWebhook(SECRET, body) }, payload: body });
};

describe("merchant plan routes", () => {
  it("401 without or with a wrong token, no-store", async () => {
    const app = make();
    for (const [method, url] of [["GET", "/api/merchant/plans"], ["POST", "/api/merchant/plans"], ["GET", "/api/merchant/subscriptions"]] as const) {
      const none = await app.inject({ method, url, payload: method === "POST" ? ({ name: "x", amount: "1", interval: "day" } as never) : undefined });
      expect(none.statusCode).toBe(401);
      const bad = await app.inject({ method, url, headers: { authorization: "Bearer nope" } });
      expect(bad.statusCode).toBe(401);
      expect(bad.headers["cache-control"]).toBe("no-store");
    }
  });

  it("creates and lists plans newest first", async () => {
    const app = make();
    const a = await createPlan(app, { name: "Basic", amount: "5.00", interval: "month" });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toEqual({ id: expect.any(String), name: "Basic", amount: "5.000000", amountBase: "5000000", interval: "month", intervalCount: 1 });
    await new Promise((r) => setTimeout(r, 1100));
    const b = await createPlan(app, { name: "Annual", amount: "50.123456", interval: "year", intervalCount: 2 });
    expect(b.json()).toMatchObject({ amountBase: "50123456", interval: "year", intervalCount: 2 });
    const list = await app.inject({ method: "GET", url: "/api/merchant/plans", headers: auth });
    expect(list.json().plans.map((p: { name: string }) => p.name)).toEqual(["Annual", "Basic"]);
  });

  it("rejects invalid plan input with 400", async () => {
    const app = make();
    for (const p of [
      {}, { name: "", amount: "5", interval: "month" }, { name: "x", amount: "0", interval: "month" },
      { name: "x", amount: "-1", interval: "month" }, { name: "x", amount: "1.1234567", interval: "month" },
      { name: "x", amount: 5, interval: "month" }, { name: "x", amount: "5", interval: "hour" },
      { name: "x", amount: "5", interval: "month", intervalCount: 0 }, { name: "x", amount: "5", interval: "month", intervalCount: 99 },
      { name: "x".repeat(81), amount: "5", interval: "month" },
    ]) {
      const r = await createPlan(app, p);
      expect(r.statusCode, JSON.stringify(p)).toBe(400);
      expect(r.json().error).toEqual(expect.any(String));
    }
  });

  it("accepts a wallet sign-in session", async () => {
    const app = make({ merchantAuth: { wallets: [wallet.address], domain: "dash.example", uri: "https://dash.example", chainId: 1874 } });
    const ch = (await app.inject({ method: "POST", url: "/api/merchant/auth/challenge", payload: { address: wallet.address } })).json();
    const signature = await wallet.signMessage({ message: ch.message });
    const session = (await app.inject({ method: "POST", url: "/api/merchant/auth/verify", payload: { nonce: ch.nonce, signature } })).json();
    const res = await app.inject({ method: "GET", url: "/api/merchant/plans", headers: { authorization: `Bearer ${session.token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe("customer routes", () => {
  it("GET plan, 404 unknown", async () => {
    const app = make();
    const plan = (await createPlan(app)).json();
    expect((await app.inject({ method: "GET", url: `/api/plans/${plan.id}` })).json()).toEqual(plan);
    expect((await app.inject({ method: "GET", url: "/api/plans/plan_nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/plans/..%2Fx" })).statusCode).toBe(404);
  });

  it("subscribe requires consent === true", async () => {
    const app = make();
    const plan = (await createPlan(app)).json();
    for (const payload of [{}, { consent: "true" }, { consent: false }, undefined]) {
      const r = await app.inject({ method: "POST", url: `/api/plans/${plan.id}/subscribe`, payload: payload as never });
      expect(r.statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: "/api/plans/plan_nope/subscribe", payload: { consent: true } })).statusCode).toBe(404);
  });

  it("subscribe creates the subscription and its first order with an order token", async () => {
    const app = make();
    const { plan, res, body } = await subscribed(app);
    expect(res.statusCode).toBe(201);
    expect(res.headers[ORDER_TOKEN_HEADER.toLowerCase()]).toEqual(expect.any(String));
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(body.checkout).toEqual({ orderId: expect.stringMatching(/^0x[0-9a-f]{64}$/), amount: "5.000000", payout: expect.stringMatching(/^0x/) });
    expect(body.subscription).toMatchObject({ plan, status: "active", paidPeriods: 0, due: true, pendingOrderId: body.checkout.orderId });
    expect(typeof body.subscription.nextCharge).toBe("string");
    const got = await app.inject({ method: "GET", url: `/api/subscriptions/${body.subscription.id}` });
    expect(got.json()).toEqual(body.subscription);
    const mine = await app.inject({ method: "GET", url: "/api/merchant/subscriptions", headers: auth });
    expect(mine.json().subscriptions[0]).toMatchObject({ id: body.subscription.id, customer: expect.stringMatching(/^web_/), createdAt: expect.any(String) });
  });

  it("unknown or malformed subscription ids 404", async () => {
    const app = make();
    for (const id of ["sub_nope", "..%2Fetc", "x".repeat(200)]) {
      expect((await app.inject({ method: "GET", url: `/api/subscriptions/${id}` })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `/api/subscriptions/${id}/renew` })).statusCode).toBe(404);
      expect((await app.inject({ method: "POST", url: `/api/subscriptions/${id}/cancel` })).statusCode).toBe(404);
    }
  });

  it("renew is idempotent while the order is open", async () => {
    const app = make();
    const { body } = await subscribed(app);
    const r = await app.inject({ method: "POST", url: `/api/subscriptions/${body.subscription.id}/renew` });
    expect(r.statusCode).toBe(200);
    expect(r.json().checkout.orderId).toBe(body.checkout.orderId);
    expect(r.json().subscription.pendingOrderId).toBe(body.checkout.orderId);
  });

  it("webhook settled advances the period; renew is then 409; forged webhooks are ignored", async () => {
    const app = make();
    const { body } = await subscribed(app);
    const id = body.subscription.id as string;
    const ref = `sub:${id}:1`;
    // Forged: right reference, an order that is not the pending one.
    const forged = await webhook(app, { orderId: "0x" + "ab".repeat(32), reference: ref });
    expect(forged.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/subscriptions/${id}` })).json().paidPeriods).toBe(0);
    // Wrong amount for the right order.
    await webhook(app, { orderId: body.checkout.orderId, reference: ref, amount: "1000000" });
    expect((await app.inject({ method: "GET", url: `/api/subscriptions/${id}` })).json().paidPeriods).toBe(0);

    const ok = await webhook(app, { orderId: body.checkout.orderId, reference: ref });
    expect(ok.statusCode).toBe(200);
    const sub = (await app.inject({ method: "GET", url: `/api/subscriptions/${id}` })).json();
    expect(sub).toMatchObject({ paidPeriods: 1, status: "active", due: false, lastPaidOrderId: body.checkout.orderId });
    expect(sub.pendingOrderId).toBeUndefined();
    expect(new Date(sub.nextCharge).getTime()).toBeGreaterThan(Date.now() + 27 * 86400_000);

    const renew = await app.inject({ method: "POST", url: `/api/subscriptions/${id}/renew` });
    expect(renew.statusCode).toBe(409);
    expect(renew.json().error).toMatch(/^Paid until /);
  });

  it("cancel stops renewals", async () => {
    const app = make();
    const { body } = await subscribed(app);
    const id = body.subscription.id as string;
    const c = await app.inject({ method: "POST", url: `/api/subscriptions/${id}/cancel` });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toMatchObject({ status: "cancelled", nextCharge: null });
    const r = await app.inject({ method: "POST", url: `/api/subscriptions/${id}/renew` });
    expect(r.statusCode).toBe(409);
  });

  it("payout mismatch is refused with 502", async () => {
    const app = make({ payout: ("0x" + "99".repeat(20)) as `0x${string}` });
    const { res } = await subscribed(app);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: expect.any(String) });
  });

  it("rate limits subscribe per IP", async () => {
    const app = make({ checkoutRateLimit: 2 });
    const plan = (await createPlan(app)).json();
    const go = () => app.inject({ method: "POST", url: `/api/plans/${plan.id}/subscribe`, payload: { consent: true }, remoteAddress: "198.51.100.7" });
    expect((await go()).statusCode).toBe(201);
    expect((await go()).statusCode).toBe(201);
    expect((await go()).statusCode).toBe(429);
  });
});

describe("billing modes", () => {
  it("one_time: every subscription route is 503", async () => {
    const app = make({ billing: "one_time" });
    const msg = { error: "Subscriptions are not enabled for this store." };
    for (const [method, url, headers] of [
      ["GET", "/api/merchant/plans", auth], ["POST", "/api/merchant/plans", auth], ["GET", "/api/merchant/subscriptions", auth],
      ["GET", "/api/plans/p1", {}], ["POST", "/api/plans/p1/subscribe", {}], ["GET", "/api/subscriptions/s1", {}],
      ["POST", "/api/subscriptions/s1/renew", {}], ["POST", "/api/subscriptions/s1/cancel", {}],
    ] as const) {
      const r = await app.inject({ method, url, headers, payload: method === "POST" ? ({ consent: true } as never) : undefined });
      expect(r.statusCode, url).toBe(503);
      expect(r.json()).toEqual(msg);
    }
  });

  it("subscription: /api/checkout is 503", async () => {
    const app = make({ billing: "subscription" });
    const r = await app.inject({ method: "POST", url: "/api/checkout", payload: { items: [{ id: "tee", quantity: 1 }] } });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "One-time checkout is turned off for this store." });
  });

  it("both: one-time checkout still works", async () => {
    const app = make();
    const r = await app.inject({ method: "POST", url: "/api/checkout", payload: { items: [{ id: "tee", quantity: 1 }] } });
    expect(r.statusCode).toBe(200);
  });
});

describe("file store", () => {
  it("plans and subscriptions survive a rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qp-subs-"));
    dirs.push(dir);
    const file = join(dir, "nested", "subs.json");
    const first = make({ subscriptionsFile: file });
    const { plan, body } = await subscribed(first);
    await first.close();
    apps = apps.filter((a) => a !== first);
    const second = make({ subscriptionsFile: file });
    expect((await second.inject({ method: "GET", url: "/api/merchant/plans", headers: auth })).json().plans).toEqual([plan]);
    expect((await second.inject({ method: "GET", url: `/api/subscriptions/${body.subscription.id}` })).json().id).toBe(body.subscription.id);
  });
});
