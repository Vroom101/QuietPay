import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockRelayer } from "@quietpay/shared/mock-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webhookSettled } from "@quietpay/shared/fixtures";
import { signWebhook } from "@quietpay/shared/webhook";
import * as sdk from "../server/sdk-stub.js";
import { buildApp } from "../server/app.js";

let relayer: Server;
let app: ReturnType<typeof buildApp>;
const SECRET = "test-secret";

beforeAll(async () => {
  relayer = createMockRelayer();
  await new Promise<void>((r) => relayer.listen(0, "127.0.0.1", r));
  app = buildApp(sdk, {
    baseUrl: `http://127.0.0.1:${(relayer.address() as AddressInfo).port}`,
    apiKey: "k",
    merchantId: webhookSettled.data.merchantId as `0x${string}`,
    webhookSecret: SECRET,
  });
});
afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => relayer.close(() => r()));
});

const post = (body: string, sig?: string) =>
  app.inject({
    method: "POST",
    url: "/webhooks/quietpay",
    headers: { "content-type": "application/json", ...(sig ? { "quietpay-signature": sig } : {}) },
    payload: body,
  });

describe("demo-store server", () => {
  it("creates an order from cartTotal", async () => {
    const res = await app.inject({ method: "POST", url: "/api/checkout", payload: { items: { notebook: 3 }, cartTotal: "25.50" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().orderId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("advertises only the supported direct payment route", async () => {
    const res = await app.inject({ url: "/api/checkout/methods" });
    expect(res.json()).toEqual({ methods: [{ id: "usdt", name: "Tether USD", symbol: "USDT", simulated: false }] });
  });

  it("rejects tampered totals and invalid quantities before creating an order", async () => {
    expect((await app.inject({ method: "POST", url: "/api/checkout", payload: { items: { notebook: 1 }, cartTotal: "0.01" } })).statusCode).toBe(409);
    for (const items of [{}, { unknown: 1 }, { notebook: -1 }, { notebook: 1.5 }, { notebook: Number.MAX_SAFE_INTEGER }]) {
      expect((await app.inject({ method: "POST", url: "/api/checkout", payload: { items, cartTotal: "8.50" } })).statusCode).toBe(400);
    }
  });

  it("retains verified receipts and duplicate detection after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quietpay-receipt-"));
    const config = { baseUrl: "http://relayer.test", apiKey: "k", merchantId: webhookSettled.data.merchantId as `0x${string}`,
      webhookSecret: SECRET, receiptDatabasePath: join(dir, "receipts.db") };
    let server = buildApp(sdk, config);
    const body = JSON.stringify(webhookSettled);
    const request = { method: "POST" as const, url: "/webhooks/quietpay", payload: body,
      headers: { "content-type": "application/json", "quietpay-signature": signWebhook(SECRET, body) } };
    try {
      expect((await server.inject(request)).statusCode).toBe(200);
      await server.close();
      server = buildApp(sdk, config);
      expect((await server.inject({ url: `/api/orders/${webhookSettled.data.orderId}/paid` })).json()).toMatchObject({ paid: true, eventId: webhookSettled.id });
      expect((await server.inject(request)).json().duplicate).toBe(true);
    } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a signed webhook for a different merchant", async () => {
    const body = JSON.stringify({ ...webhookSettled, id: "evt_foreign_merchant", data: { ...webhookSettled.data, merchantId: "0x" + "ab".repeat(32) } });
    expect((await post(body, signWebhook(SECRET, body))).statusCode).toBe(400);
  });

  it("rejects a bad cartTotal", async () => {
    for (const cartTotal of ["abc", "-1", "0", "1.234", 5]) {
      const res = await app.inject({ method: "POST", url: "/api/checkout", payload: { cartTotal } });
      expect(res.statusCode).toBe(400);
    }
  });

  it("verifies webhooks, stores the paid order and dedupes by event id", async () => {
    const body = JSON.stringify(webhookSettled);
    const id = webhookSettled.data.orderId;
    expect((await app.inject({ method: "GET", url: `/api/orders/${id}/paid` })).json().paid).toBe(false);

    const first = await post(body, signWebhook(SECRET, body));
    expect(first.statusCode).toBe(200);
    expect(first.json().duplicate).toBeUndefined();
    const dup = await post(body, signWebhook(SECRET, body));
    expect(dup.json().duplicate).toBe(true);

    const paid = (await app.inject({ method: "GET", url: `/api/orders/${id}/paid` })).json();
    expect(paid).toMatchObject({ paid: true, amount: webhookSettled.data.amount, eventId: webhookSettled.id });
  });

  it("rejects bad signature, stale timestamp and missing header", async () => {
    const body = JSON.stringify({ ...webhookSettled, id: "evt_other_0002" });
    expect((await post(body, signWebhook("wrong-secret", body))).statusCode).toBe(400);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await post(body, signWebhook(SECRET, body, stale))).statusCode).toBe(400);
    expect((await post(body)).statusCode).toBe(400);
  });
});
