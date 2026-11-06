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

beforeAll(async () => {
  relayer = createMockRelayer();
  await new Promise<void>((r) => relayer.listen(0, "127.0.0.1", r));
  app = buildApp(sdk, {
    baseUrl: `http://127.0.0.1:${(relayer.address() as AddressInfo).port}`,
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
  it("creates an order from cartTotal", async () => {
    const res = await app.inject({ method: "POST", url: "/api/checkout", payload: { cartTotal: "25.50" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().orderId).toMatch(/^0x[0-9a-f]{64}$/);
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
