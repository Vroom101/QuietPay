import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMockRelayer } from "@quietpay/shared/mock-server";
import { merchantIdFromSlug } from "@quietpay/shared";
import { webhookSettled } from "@quietpay/shared/fixtures";
import { signWebhook } from "@quietpay/shared/webhook";
import * as sdk from "@quietpay/merchant-sdk";
import { buildApp } from "../server/app.js";

let relayer: Server;
let app: ReturnType<typeof buildApp>;
const SECRET = "test-secret";
let baseUrl: string;

beforeAll(async () => {
  relayer = createMockRelayer();
  await new Promise<void>((r) => relayer.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(relayer.address() as AddressInfo).port}`;
  app = buildApp(sdk, {
    baseUrl,
    apiKey: "k",
    merchantId: merchantIdFromSlug("demo-store"),
    webhookSecret: SECRET,
    demoConversion: true,
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
  it("prices a multi-item cart from the catalog and sends the correct base units", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: { items: { mug: 2, notebook: 1 }, cartTotal: "32.50" },
    });
    expect(res.statusCode).toBe(200);
    const { orderId } = res.json();
    expect(orderId).toMatch(/^0x[0-9a-f]{64}$/);
    const order = await sdk.getOrder({ baseUrl, orderId });
    expect(order.amount).toBe("32500000");
  });

  it("rejects missing items, invalid products and quantities, and totals outside the limit", async () => {
    for (const items of [undefined, [], {}, { unknown: 1 }, { mug: 0 }, { mug: -1 }, { mug: 1.5 }, { mug: "2" }, { mug: Number.MAX_SAFE_INTEGER }]) {
      const res = await app.inject({ method: "POST", url: "/api/checkout", payload: { items, cartTotal: "12.00" } });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects an amount that does not match the server-priced cart", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: { items: { mug: 1 }, cartTotal: "0.01" },
    });
    expect(res.statusCode).toBe(409);
  });

  const quoteDemo = () => app.inject({
    method: "POST", url: "/api/checkout/demo-quote",
    payload: { items: { notebook: 1 }, cartTotal: "8.50", methodId: "demo-stablecoin" },
  });

  it("quotes the server-priced cart and keeps simulated confirmation separate from paid orders", async () => {
    const quote = (await quoteDemo()).json();
    expect(quote).toMatchObject({ symbol: "DEMO", payAmount: "8.50", merchantAmount: "8.40", relayFee: "0.10" });
    const confirm = () => app.inject({ method: "POST", url: "/api/checkout/demo-confirm", payload: { quoteId: quote.id } });
    expect((await confirm()).json()).toEqual({ orderId: quote.id });
    expect((await confirm()).json()).toEqual({ orderId: quote.id });
    const status = (await app.inject({ url: `/api/orders/${quote.id}/paid` })).json();
    expect(status).toMatchObject({ paid: false, simulation: { quote } });
  });

  it("rejects expired quotes", async () => {
    const quote = (await quoteDemo()).json();
    const now = vi.spyOn(Date, "now").mockReturnValue(quote.expiresAt);
    try {
      const res = await app.inject({ method: "POST", url: "/api/checkout/demo-confirm", payload: { quoteId: quote.id } });
      expect(res.statusCode).toBe(409);
    } finally {
      now.mockRestore();
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
