import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@quietpay/shared/webhook";
import { buildServer } from "../src/server.js";
import { WebhookWorker } from "../src/webhooks.js";
import { MERCHANT_ID, makeEnv, newOrder, signFor } from "./helpers.js";

const auth = { authorization: "Bearer test-key" };
const op = { authorization: "Bearer operator-token-123456" };

describe("HTTP surface", () => {
  it("health reports router and paused", async () => {
    const { svc, cfg } = makeEnv();
    const res = await buildServer(svc).inject({ url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, router: cfg.router, paused: false, chainId: 1874 });
  });

  it("creating orders needs the merchant API key for that merchant", async () => {
    const { svc } = makeEnv();
    const app = buildServer(svc);
    const payload = { merchantId: MERCHANT_ID, amount: "1000000" };
    expect((await app.inject({ method: "POST", url: "/v1/orders", payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/orders", payload, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    const other = { merchantId: "0x" + "09".repeat(32), amount: "1000000" };
    expect((await app.inject({ method: "POST", url: "/v1/orders", payload: other, headers: auth })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/v1/orders", payload, headers: auth });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().status).toBe("created");
  });

  it("order reads are public; lists need the API key and only show that merchant", async () => {
    const { svc } = makeEnv();
    const app = buildServer(svc);
    const o = await newOrder(svc);
    expect((await app.inject({ url: `/v1/orders/${o.id}` })).json().id).toBe(o.id);
    expect((await app.inject({ url: "/v1/orders" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/orders", headers: auth })).json().orders).toHaveLength(1);
    const missing = await app.inject({ url: `/v1/orders/0x${"ee".repeat(32)}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("order_not_found");
  });

  it("metrics and pause need the operator token, and pause blocks relaying", async () => {
    const { svc, clock, chain } = makeEnv();
    const app = buildServer(svc);
    expect((await app.inject({ url: "/v1/metrics" })).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/metrics", headers: auth })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/admin/pause", payload: { paused: true } })).statusCode).toBe(401);

    expect((await app.inject({ method: "POST", url: "/v1/admin/pause", payload: { paused: true }, headers: op })).json()).toEqual({ paused: true });
    const o = await newOrder(svc);
    const res = await app.inject({ method: "POST", url: "/v1/relay/pay", payload: await signFor(o, clock.t) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("relayer_paused");
    expect(chain.sent).toHaveLength(0);
    expect((await app.inject({ url: "/v1/health" })).json().paused).toBe(true);

    await app.inject({ method: "POST", url: "/v1/admin/pause", payload: { paused: false }, headers: op });
    const m = (await app.inject({ url: "/v1/metrics", headers: op })).json();
    expect(m.paused).toBe(false);
    expect(m.rejected.relayer_paused).toBe(1);
  });

  it("malformed relay requests get a frozen error code and never reach the chain", async () => {
    const { svc, chain } = makeEnv();
    const app = buildServer(svc);
    const res = await app.inject({ method: "POST", url: "/v1/relay/pay", payload: { orderId: "nope" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bad_signature");
    expect(chain.sent).toHaveLength(0);
  });

  it("returns frozen codes with matching HTTP status through the API", async () => {
    const { svc, clock } = makeEnv();
    const app = buildServer(svc);
    const o = await newOrder(svc);
    const req = await signFor(o, clock.t);
    const bad = await app.inject({ method: "POST", url: "/v1/relay/pay", payload: { ...req, amount: "1" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("amount_mismatch");
  });
});

describe("webhook worker", () => {
  it("signs every attempt, retries failures with backoff, then stops after success", async () => {
    const { svc, db, clock, chain } = makeEnv();
    const o = await newOrder(svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    await svc.relayPay(await signFor(o, clock.t), { ip: "1.1.1.1" });
    await new Promise((r) => setTimeout(r, 10));
    expect(chain.sent).toHaveLength(1);

    const calls: { sig: string; body: string }[] = [];
    let status = 500;
    const worker = new WebhookWorker(db, "whsec_test_secret_123456", () => clock.t, async (_u, init) => {
      calls.push({ sig: init.headers["Quietpay-Signature"]!, body: init.body });
      return { status };
    });

    expect(await worker.tick()).toBe(0); // 500 -> scheduled for retry
    expect(await worker.tick()).toBe(0); // not due yet, nothing happens
    expect(calls).toHaveLength(1);

    clock.t += 5; // first backoff
    expect(await worker.tick()).toBe(0);
    expect(calls).toHaveLength(2);

    status = 200;
    clock.t += 30; // second backoff
    expect(await worker.tick()).toBe(1);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(verifyWebhookSignature("whsec_test_secret_123456", c.body, c.sig, { nowSeconds: clock.t })).toBe(true);
    // Same event id each time so receivers can dedupe.
    expect(new Set(calls.map((c) => JSON.parse(c.body).id)).size).toBe(1);

    clock.t += 10_000;
    expect(await worker.tick()).toBe(0);
    expect(calls).toHaveLength(3);
  });

  it("gives up after the maximum attempts", async () => {
    const { svc, db, clock } = makeEnv();
    const o = await newOrder(svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    await svc.relayPay(await signFor(o, clock.t), { ip: "1.1.1.1" });
    await new Promise((r) => setTimeout(r, 10));
    let n = 0;
    const worker = new WebhookWorker(db, "whsec_test_secret_123456", () => clock.t, async () => {
      n += 1;
      return { status: 503 };
    });
    for (let i = 0; i < 30; i++) {
      await worker.tick();
      clock.t += 7200;
    }
    expect(n).toBe(7);
  });
});
