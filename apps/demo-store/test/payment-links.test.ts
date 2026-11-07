import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMockRelayer } from "@quietpay/shared/mock-server";
import { merchantIdFromSlug, ORDER_TOKEN_HEADER } from "@quietpay/shared";
import { signWebhook } from "@quietpay/shared/webhook";
import * as sdk from "@quietpay/merchant-sdk";
import { buildApp, type StoreConfig } from "../server/app.js";

const SECRET = "test-secret";
const DASH = "dashboard-test-access-token-at-least-32-characters";
const merchantId = merchantIdFromSlug("demo-store");
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

type App = ReturnType<typeof buildApp>;
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
const createLink = (app: App, payload: Record<string, unknown> = { title: "Logo design", amount: "12.50" }) =>
  app.inject({ method: "POST", url: "/api/merchant/links", headers: auth, payload: payload as never });
const checkout = (app: App, id: string, ip = "203.0.113.1") =>
  app.inject({ method: "POST", url: `/api/links/${id}/checkout`, remoteAddress: ip });
const webhook = (app: App, over: { orderId: string; reference: string; amount?: string; id?: string }) => {
  const body = JSON.stringify({
    id: over.id ?? "evt_link_" + Math.random().toString(16).slice(2, 12),
    type: "payment.settled",
    createdAt: Math.floor(Date.now() / 1000),
    data: { orderId: over.orderId, merchantId, amount: over.amount ?? "12500000", fee: "50000", payout: "0x" + "33".repeat(20), reference: over.reference },
  });
  return app.inject({ method: "POST", url: "/webhooks/quietpay", headers: { "content-type": "application/json", "quietpay-signature": signWebhook(SECRET, body) }, payload: body });
};
/** Creates a link, starts a checkout and returns what a settled webhook for it needs. */
async function started(app: App, payload?: Record<string, unknown>) {
  const link = (await createLink(app, payload)).json();
  const res = await checkout(app, link.id);
  return { link, res, orderId: res.json().checkout?.orderId as string };
}
const getLink = async (app: App, id: string) => (await app.inject({ method: "GET", url: "/api/merchant/links", headers: auth })).json().links.find((l: { id: string }) => l.id === id);

describe("merchant link routes", () => {
  it("401 without or with a wrong token, no-store", async () => {
    const app = make();
    for (const [method, url] of [["GET", "/api/merchant/links"], ["POST", "/api/merchant/links"], ["POST", "/api/merchant/links/x/deactivate"]] as const) {
      const none = await app.inject({ method, url, payload: method === "POST" ? ({ title: "x", amount: "1" } as never) : undefined });
      expect(none.statusCode).toBe(401);
      const bad = await app.inject({ method, url, headers: { authorization: "Bearer nope" } });
      expect(bad.statusCode).toBe(401);
      expect(bad.headers["cache-control"]).toBe("no-store");
    }
  });

  it("creates a link with defaults and lists newest first", async () => {
    const app = make();
    const a = await createLink(app, { title: "Logo design", amount: "12.50", description: "Final files" });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toEqual({
      id: expect.any(String), title: "Logo design", description: "Final files", amount: "12.500000", amountBase: "12500000", singleUse: true,
      status: "active", paidCount: 0, expiresAt: null, createdAt: expect.any(String), lastPaidOrderId: null, duplicatePayments: 0,
    });
    await new Promise((r) => setTimeout(r, 1100));
    const b = await createLink(app, { title: "Second", amount: "1", singleUse: false, expiresInDays: 7 });
    expect(b.json()).toMatchObject({ description: null, singleUse: false });
    const exp = Date.parse(b.json().expiresAt) - Date.parse(b.json().createdAt);
    expect(exp).toBe(7 * 86400 * 1000);
    const list = await app.inject({ method: "GET", url: "/api/merchant/links", headers: auth });
    expect(list.json().links.map((l: { title: string }) => l.title)).toEqual(["Second", "Logo design"]);
  });

  it("rejects invalid input with 400", async () => {
    const app = make();
    for (const p of [
      {}, { title: "", amount: "5" }, { title: "x", amount: "0" }, { title: "x", amount: "-1" }, { title: "x", amount: "1.1234567" },
      { title: "x", amount: 5 }, { title: "x".repeat(81), amount: "5" }, { title: "x", amount: "1000000.000001" },
      { title: "x", amount: "5", description: "d".repeat(281) }, { title: "x", amount: "5", description: 3 },
      { title: "x", amount: "5", singleUse: "yes" }, { title: "x", amount: "5", expiresInDays: 0 },
      { title: "x", amount: "5", expiresInDays: 91 }, { title: "x", amount: "5", expiresInDays: 1.5 }, { title: "x", amount: "5", expiresInDays: "3" },
    ]) {
      const r = await createLink(app, p);
      expect(r.statusCode, JSON.stringify(p)).toBe(400);
      expect(r.json().error).toEqual(expect.any(String));
    }
    expect((await createLink(app, { title: "max", amount: "1000000" })).statusCode).toBe(201);
  });

  it("deactivates a link; unknown or malformed ids are 404", async () => {
    const app = make();
    const link = (await createLink(app)).json();
    const res = await app.inject({ method: "POST", url: `/api/merchant/links/${link.id}/deactivate`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("deactivated");
    expect((await app.inject({ method: "POST", url: "/api/merchant/links/nope/deactivate", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/merchant/links/a%20b/deactivate", headers: auth })).statusCode).toBe(404);
  });
});

describe("public link routes", () => {
  it("shows the public view (no merchant fields) with the merchant name", async () => {
    const app = make({ merchantName: "Ava Studio" });
    const link = (await createLink(app, { title: "Logo", amount: "12.50", description: "Final files" })).json();
    const res = await app.inject({ method: "GET", url: `/api/links/${link.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: link.id, title: "Logo", description: "Final files", amount: "12.500000", status: "active", expiresAt: null, merchantName: "Ava Studio" });
    const dflt = make();
    const l2 = (await createLink(dflt)).json();
    expect((await dflt.inject({ method: "GET", url: `/api/links/${l2.id}` })).json().merchantName).toBe("Quiet Store");
  });

  it("404 for unknown and malformed ids", async () => {
    const app = make();
    expect((await app.inject({ method: "GET", url: "/api/links/unknown" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/links/a%20b%3Cscript%3E" })).statusCode).toBe(404);
    expect((await checkout(app, "unknown")).statusCode).toBe(404);
  });

  it("checkout creates an order for the link amount, with the order token header", async () => {
    const app = make();
    const { res } = await started(app);
    expect(res.statusCode).toBe(201);
    expect(res.json().checkout).toEqual({ orderId: expect.stringMatching(/^0x[0-9a-f]{64}$/), amount: "12.500000", payout: expect.stringMatching(/^0x/) });
    expect(String(res.headers[ORDER_TOKEN_HEADER.toLowerCase()]).length).toBeGreaterThan(20);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("an expired link is shown as expired and refuses checkout with 409", async () => {
    const app = make();
    const link = (await createLink(app, { title: "Soon", amount: "1", expiresInDays: 1 })).json();
    const real = Date.now;
    Date.now = () => real() + 2 * 86400 * 1000;
    try {
      expect((await app.inject({ method: "GET", url: `/api/links/${link.id}` })).json().status).toBe("expired");
      expect((await getLink(app, link.id)).status).toBe("expired");
      const res = await checkout(app, link.id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/expired/i);
    } finally {
      Date.now = real;
    }
  });

  it("a deactivated link refuses checkout with 409", async () => {
    const app = make();
    const link = (await createLink(app)).json();
    await app.inject({ method: "POST", url: `/api/merchant/links/${link.id}/deactivate`, headers: auth });
    const res = await checkout(app, link.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no longer active/i);
    expect((await app.inject({ method: "GET", url: `/api/links/${link.id}` })).json().status).toBe("deactivated");
  });

  it("a payout that is not the store's is refused with 502", async () => {
    const app = make({ payout: ("0x" + "99".repeat(20)) as `0x${string}` });
    const link = (await createLink(app)).json();
    const res = await checkout(app, link.id);
    expect(res.statusCode).toBe(502);
    expect(res.headers[ORDER_TOKEN_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("a relayer that answers with the wrong amount or merchant is refused with 502", async () => {
    for (const bad of [{ amount: "1" }, { merchantId: "0x" + "ab".repeat(32) }]) {
      const app = make({
        subscriptionsFetch: (async (url: string | URL | Request, init?: RequestInit) => {
          const res = await fetch(url, init);
          if (init?.method !== "POST") return res;
          return new Response(JSON.stringify({ ...(await res.json()), ...bad }), { status: res.status, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
      });
      const link = (await createLink(app)).json();
      expect((await checkout(app, link.id)).statusCode, JSON.stringify(bad)).toBe(502);
    }
  });

  it("checkout is rate limited per IP", async () => {
    const app = make({ checkoutRateLimit: 2 });
    const link = (await createLink(app, { title: "Multi", amount: "1", singleUse: false })).json();
    expect((await checkout(app, link.id)).statusCode).toBe(201);
    expect((await checkout(app, link.id)).statusCode).toBe(201);
    expect((await checkout(app, link.id)).statusCode).toBe(429);
    expect((await checkout(app, link.id, "203.0.113.9")).statusCode).toBe(201);
  });

  it("reads are rate limited per IP too", async () => {
    const app = make({ checkoutRateLimit: 1 }); // read limit is 10x
    const link = (await createLink(app)).json();
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await app.inject({ method: "GET", url: `/api/links/${link.id}` })).statusCode;
    expect(last).toBe(429);
  });
});

describe("webhook credit", () => {
  it("a settled payment closes a single-use link and a second checkout is refused", async () => {
    const app = make();
    const { link, orderId } = await started(app);
    expect((await webhook(app, { orderId, reference: `link:${link.id}:1` })).statusCode).toBe(200);
    const after = await getLink(app, link.id);
    expect(after).toMatchObject({ status: "paid", paidCount: 1, lastPaidOrderId: orderId });
    const again = await checkout(app, link.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already been paid/i);
    expect((await app.inject({ method: "GET", url: `/api/links/${link.id}` })).json().status).toBe("paid");
  });

  it("a reusable link stays active and counts every payment", async () => {
    const app = make();
    const link = (await createLink(app, { title: "Tip jar", amount: "12.50", singleUse: false })).json();
    for (let n = 1; n <= 2; n++) {
      const orderId = (await checkout(app, link.id)).json().checkout.orderId;
      expect((await webhook(app, { orderId, reference: `link:${link.id}:${n}` })).statusCode).toBe(200);
    }
    expect(await getLink(app, link.id)).toMatchObject({ status: "active", paidCount: 2 });
  });

  it("a replayed event does not double count", async () => {
    const app = make();
    const link = (await createLink(app, { title: "Tip jar", amount: "12.50", singleUse: false })).json();
    const orderId = (await checkout(app, link.id)).json().checkout.orderId;
    await webhook(app, { orderId, reference: `link:${link.id}:1`, id: "evt_link_aaaaaaaaaa" });
    await webhook(app, { orderId, reference: `link:${link.id}:1`, id: "evt_link_bbbbbbbbbb" }); // different event id, same order
    expect((await getLink(app, link.id)).paidCount).toBe(1);
  });

  it("a second order paid on a closed single-use link is reported as a duplicate payment", async () => {
    const app = make();
    const link = (await createLink(app)).json();
    const a = (await checkout(app, link.id)).json().checkout.orderId;
    const b = (await checkout(app, link.id)).json().checkout.orderId; // both opened before either paid
    await webhook(app, { orderId: a, reference: `link:${link.id}:1` });
    await webhook(app, { orderId: b, reference: `link:${link.id}:2` });
    expect(await getLink(app, link.id)).toMatchObject({ status: "paid", paidCount: 1, duplicatePayments: 1 });
  });

  it("an order the link never issued credits nothing", async () => {
    const app = make();
    const link = (await createLink(app)).json();
    const other = (await checkout(app, (await createLink(app)).json().id)).json().checkout.orderId;
    await webhook(app, { orderId: other, reference: `link:${link.id}:1` });
    expect(await getLink(app, link.id)).toMatchObject({ status: "active", paidCount: 0 });
  });
});

describe("subscription-only stores", () => {
  it("every link route answers 503", async () => {
    const app = make({ billing: "subscription" });
    const off = { error: "Payment links are turned off for this store." };
    for (const [method, url] of [
      ["GET", "/api/merchant/links"], ["POST", "/api/merchant/links"], ["POST", "/api/merchant/links/x/deactivate"],
      ["GET", "/api/links/x"], ["POST", "/api/links/x/checkout"],
    ] as const) {
      const r = await app.inject({ method, url, headers: auth, payload: method === "POST" ? ({ title: "x", amount: "1" } as never) : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(503);
      expect(r.json()).toEqual(off);
    }
  });
});

describe("file store", () => {
  it("links and their payments survive a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qp-links-"));
    dirs.push(dir);
    const file = join(dir, "nested", "links.json");
    const first = make({ paymentLinksFile: file });
    const { link, orderId } = await started(first);
    await webhook(first, { orderId, reference: `link:${link.id}:1` });
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).links).toHaveLength(1);
    await first.close();
    apps.splice(apps.indexOf(first), 1);
    const second = make({ paymentLinksFile: file });
    expect(await getLink(second, link.id)).toMatchObject({ title: "Logo design", status: "paid", paidCount: 1 });
    expect((await checkout(second, link.id)).statusCode).toBe(409);
  });
});
