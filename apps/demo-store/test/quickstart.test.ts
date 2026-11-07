import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { makeOrder } from "@quietpay/shared/fixtures";
import { signWebhook } from "@quietpay/shared/webhook";
import { createQuietPay } from "@quietpay/merchant-sdk";
import { quickstart } from "../server/quickstart.js";

const MERCHANT = "0x" + "1d".repeat(32);
const SECRET = "s".repeat(32);
const ENV = { QUIETPAY_BASE_URL: "http://relayer.test", QUIETPAY_API_KEY: "k", QUIETPAY_MERCHANT_ID: MERCHANT, QUIETPAY_WEBHOOK_SECRET: SECRET };

function build() {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
    return Response.json(makeOrder({ merchantId: MERCHANT as `0x${string}`, amount: JSON.parse(String(init.body)).amount }));
  }) as unknown as typeof globalThis.fetch;
  return { app: quickstart(createQuietPay({ env: ENV, billing: "product", fetch })), calls };
}

describe("Feature: the merchant integration fits in 20 lines", () => {
  it("quickstart.ts is at most 20 lines long (blank lines and comments included)", () => {
    const text = readFileSync(fileURLToPath(new URL("../server/quickstart.ts", import.meta.url)), "utf8");
    expect(text.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(20);
  });

  it("POST /checkout creates the order with the key from the environment and returns what the widget needs", async () => {
    const { app, calls } = build();
    const r = await app.inject({ method: "POST", url: "/checkout" });
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(["amount", "orderId", "payout"]);
    expect(calls).toEqual([{ url: "http://relayer.test/v1/orders", auth: "Bearer k" }]);
  });

  it("a correctly signed webhook is accepted and a payment.settled event is reported", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { app } = build();
    const orderId = "0x" + "ab".repeat(32);
    const body = JSON.stringify({
      id: "evt_12345678", type: "payment.settled", createdAt: Math.floor(Date.now() / 1000),
      data: { orderId, merchantId: MERCHANT, amount: "8500000", fee: "50000", payout: "0x" + "22".repeat(20) },
    });
    const r = await app.inject({ method: "POST", url: "/webhooks/quietpay", headers: { "content-type": "application/json", "quietpay-signature": signWebhook(SECRET, body) }, payload: body });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ received: true });
    expect(log).toHaveBeenCalledWith("paid:", orderId);
    log.mockRestore();
  });

  it("a forged or unsigned webhook is refused with 400 and nothing is reported", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { app } = build();
    const body = JSON.stringify({ id: "evt_12345678", type: "payment.settled" });
    for (const headers of [{ "quietpay-signature": signWebhook("wrong-secret-wrong-secret-wrong-1", body) }, {}]) {
      const r = await app.inject({ method: "POST", url: "/webhooks/quietpay", headers: { "content-type": "application/json", ...headers }, payload: body });
      expect(r.statusCode).toBe(400);
    }
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
