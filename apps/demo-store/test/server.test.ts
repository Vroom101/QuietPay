import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockRelayer } from "@quietpay/shared/mock-server";
import { merchantIdFromSlug } from "@quietpay/shared";
import { webhookSettled } from "@quietpay/shared/fixtures";
import { signWebhook } from "@quietpay/shared/webhook";
import * as sdk from "../server/sdk-stub.js";
import { buildApp } from "../server/app.js";

let relayer: Server;
let app: ReturnType<typeof buildApp>;
const SECRET = "test-secret";
const relayerUrl = () => `http://127.0.0.1:${(relayer.address() as AddressInfo).port}`;

beforeAll(async () => {
  relayer = createMockRelayer();
  await new Promise<void>((r) => relayer.listen(0, "127.0.0.1", r));
  app = buildApp(sdk, {
    baseUrl: relayerUrl(),
    apiKey: "k",
    merchantId: merchantIdFromSlug("demo-store"),
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
  it("creates an order priced from the server catalog", async () => {
    // 2 x tee (25.00) + 1 x notebook (8.50) = 58.50 USDT; a client-supplied cartTotal is ignored.
    const res = await app.inject({
      method: "POST",
      url: "/api/checkout",
      payload: { items: [{ id: "tee", quantity: 2 }, { id: "notebook", quantity: 1 }], cartTotal: "0.01" },
    });
    expect(res.statusCode).toBe(200);
    const orderId = res.json().orderId as `0x${string}`;
    expect(orderId).toMatch(/^0x[0-9a-f]{64}$/);
    const order = await sdk.getOrder({ baseUrl: relayerUrl(), orderId });
    expect(order.amount).toBe("58500000");
  });

  it("rejects a bad cart", async () => {
    for (const items of [
      undefined,
      [],
      "tee",
      [{ id: "nope", quantity: 1 }],
      [{ id: "tee", quantity: 0 }],
      [{ id: "tee", quantity: -1 }],
      [{ id: "tee", quantity: 1.5 }],
      [{ id: "tee", quantity: "1" }],
      [{ id: "tee", quantity: 100 }],
      [{ id: "__proto__", quantity: 1 }],
      [null],
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/checkout", payload: { items } });
      expect(res.statusCode).toBe(400);
    }
    // The old price-from-the-browser shape is rejected outright.
    const legacy = await app.inject({ method: "POST", url: "/api/checkout", payload: { cartTotal: "25.50" } });
    expect(legacy.statusCode).toBe(400);
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

  it("does not mark an order paid when the relayer does not report it settled for that amount", async () => {
    // A fresh order exists on the relayer but is only "created", not settled.
    const res = await app.inject({ method: "POST", url: "/api/checkout", payload: { items: [{ id: "mug", quantity: 1 }] } });
    const orderId = res.json().orderId as string;
    const body = JSON.stringify({ ...webhookSettled, id: "evt_unsettled_0003", data: { ...webhookSettled.data, orderId, amount: "12000000" } });
    expect((await post(body, signWebhook(SECRET, body))).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/orders/${orderId}/paid` })).json().paid).toBe(false);
  });

  it("rejects a webhook for a different merchant", async () => {
    const body = JSON.stringify({
      ...webhookSettled,
      id: "evt_other_merchant_0004",
      data: { ...webhookSettled.data, merchantId: merchantIdFromSlug("some-other-shop") },
    });
    expect((await post(body, signWebhook(SECRET, body))).statusCode).toBe(400);
  });

  it("persists paid orders and processed event ids across a restart when a stateFile is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-store-"));
    const stateFile = join(dir, "state.json");
    const config = { baseUrl: relayerUrl(), apiKey: "k", merchantId: merchantIdFromSlug("demo-store"), webhookSecret: SECRET, stateFile };
    const body = JSON.stringify({ ...webhookSettled, id: "evt_persist_0005" });
    try {
      const first = buildApp(sdk, config);
      expect((await first.inject({ method: "POST", url: "/webhooks/quietpay", headers: { "content-type": "application/json", "quietpay-signature": signWebhook(SECRET, body) }, payload: body })).json()).toEqual({ received: true });
      await first.close();

      const second = buildApp(sdk, config);
      const again = await second.inject({ method: "POST", url: "/webhooks/quietpay", headers: { "content-type": "application/json", "quietpay-signature": signWebhook(SECRET, body) }, payload: body });
      expect(again.json()).toEqual({ received: true, duplicate: true });
      expect((await second.inject({ method: "GET", url: `/api/orders/${webhookSettled.data.orderId}/paid` })).json().paid).toBe(true);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
