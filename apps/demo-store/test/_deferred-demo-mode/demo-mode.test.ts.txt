import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
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
    mockRelayer: true, demoConversion: true,
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

  const quoteDemo = (methodId = "demo-stablecoin", destinationId = "usdt") => app.inject({
    method: "POST", url: "/api/checkout/demo-quote",
    payload: { items: { notebook: 1 }, cartTotal: "8.50", methodId, destinationId },
  });

  it("quotes the server-priced cart and keeps simulated confirmation separate from paid orders", async () => {
    const quote = (await quoteDemo()).json();
    expect(quote).toMatchObject({ symbol: "DEMO", settlementSymbol: "USDT", payAmount: "8.50", merchantAmount: "8.40", relayFee: "0.10" });
    const confirm = () => app.inject({ method: "POST", url: "/api/checkout/demo-confirm", payload: { quoteId: quote.id } });
    expect((await confirm()).json()).toEqual({ orderId: quote.id });
    expect((await confirm()).json()).toEqual({ orderId: quote.id });
    const status = (await app.inject({ url: `/api/orders/${quote.id}/paid` })).json();
    expect(status).toMatchObject({ paid: false, simulation: { quote } });
  });

  it("publishes the merchant settlement asset and rejects attempts to change it", async () => {
    const config = await app.inject({ url: "/api/checkout/methods" });
    expect(config.json()).toMatchObject({ settlementSymbol: "USDT" });
    expect((await quoteDemo("demo-stablecoin", "demo-stablecoin")).statusCode).toBe(400);
    expect((await quoteDemo("usdt", "usdt")).statusCode).toBe(400);
    expect((await quoteDemo("usdt", "unknown")).statusCode).toBe(400);
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

  it("uses the saved invoice total, settles once, and caps idempotent refunds", async () => {
    const request = (url: string, payload: object) => app.inject({ method: "POST", url, payload });
    const invoiceResponse = await request("/api/demo/merchant/invoices", {
      client: "Studio", description: "Design work", amount: "20.00", dueDate: "2027-01-10", reminderDays: 3,
    });
    expect(invoiceResponse.statusCode).toBe(201);
    const invoice = invoiceResponse.json();
    const makeQuote = () => request("/api/checkout/demo-quote", {
      invoiceId: invoice.id, methodId: "demo-stablecoin", cartTotal: "0.01",
    });
    const first = (await makeQuote()).json();
    const second = (await makeQuote()).json();
    expect(first.payAmount).toBe("20.00");
    expect((await request("/api/checkout/demo-confirm", { quoteId: first.id })).statusCode).toBe(200);
    expect((await request("/api/checkout/demo-confirm", { quoteId: second.id })).statusCode).toBe(409);
    expect((await app.inject({ url: `/api/demo/invoices/${invoice.id}` })).json().paymentId).toBe(first.id);

    const refundPath = `/api/demo/merchant/orders/${first.id}/refunds`;
    const requestId = randomUUID();
    expect((await request(refundPath, { amount: "5.00", requestId })).statusCode).toBe(200);
    expect((await request(refundPath, { amount: "5.00", requestId })).statusCode).toBe(200);
    expect((await request(refundPath, { amount: "15.01", requestId: randomUUID() })).statusCode).toBe(409);
    expect((await request(refundPath, { amount: "15.00", requestId: randomUUID() })).statusCode).toBe(200);
    const receipt = (await app.inject({ url: `/api/orders/${first.id}/paid` })).json();
    expect(receipt.refunds.map((refund: { amount: string }) => refund.amount)).toEqual(["5.00", "15.00"]);
  });

  it("requires subscription consent and clears future charge dates on cancellation", async () => {
    const plan = (await app.inject({ method: "POST", url: "/api/demo/merchant/plans", payload: { name: "Monthly", amount: "12.00", interval: "month" } })).json();
    const requestId = randomUUID();
    const subscribe = (consent: boolean) => app.inject({ method: "POST", url: `/api/demo/plans/${plan.id}/subscribe`, payload: { consent, requestId } });
    expect((await subscribe(false)).statusCode).toBe(400);
    expect((await subscribe(true)).json()).toMatchObject({ id: requestId, status: "active", nextCharge: expect.any(String) });
    await app.inject({ method: "POST", url: `/api/demo/subscriptions/${requestId}/cancel` });
    expect((await subscribe(true)).json()).toMatchObject({ status: "cancelled", nextCharge: null });
  });

  it("creates a standalone payment link without invoice contact or date fields", async () => {
    const response = await app.inject({ method: "POST", url: "/api/demo/merchant/invoices", payload: {
      kind: "link", description: "Project deposit", amount: "15.00",
    } });
    expect(response.statusCode).toBe(201);
    const link = response.json();
    expect(link).toMatchObject({ kind: "link", client: "", dueDate: null, reminderDays: null });
    const quote = await app.inject({ method: "POST", url: "/api/checkout/demo-quote", payload: {
      invoiceId: link.id, methodId: "demo-stablecoin",
    } });
    expect(quote.json()).toMatchObject({ invoiceId: link.id, payAmount: "15.00" });
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
