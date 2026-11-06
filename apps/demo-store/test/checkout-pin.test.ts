/**
 * /api/checkout returns the amount the server priced and the store's payout so the checkout page can pin them on
 * <quietpay-checkout> (expected-amount / expected-payout). An order the relayer creates differently is never handed out.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as realSdk from "@quietpay/merchant-sdk";
import { merchantIdFromSlug, parseUsdt } from "@quietpay/shared";
import { FIXTURE_PAYOUT, makeOrder } from "@quietpay/shared/fixtures";
import { buildApp, type MerchantSdk, type StoreConfig } from "../server/app.js";
import { parseCheckoutSession } from "../src/checkout-session.js";

const MERCHANT = merchantIdFromSlug("demo-store");
const OWN_PAYOUT = FIXTURE_PAYOUT;
const ATTACKER = "0x000000000000000000000000000000000000bEEF" as const;

let createOrder: ReturnType<typeof vi.fn>;

function app(over: Partial<StoreConfig> = {}) {
  const sdk: MerchantSdk = {
    createOrder: createOrder as unknown as MerchantSdk["createOrder"],
    getOrder: vi.fn() as unknown as MerchantSdk["getOrder"],
    verifyWebhook: realSdk.verifyWebhook,
  };
  return buildApp(sdk, { baseUrl: "http://relayer.invalid", apiKey: "k", merchantId: MERCHANT, webhookSecret: "s", ...over });
}

const checkout = (a: ReturnType<typeof app>) =>
  a.inject({ method: "POST", url: "/api/checkout", payload: { items: [{ id: "tee", quantity: 2 }, { id: "notebook", quantity: 1 }] } });

beforeEach(() => {
  createOrder = vi.fn(async (o: { amount: string }) => makeOrder({ amount: o.amount, fee: "0" }));
});

describe("/api/checkout pins amount and payout for the widget", () => {
  it("returns the server-priced amount (decimal) and the configured payout", async () => {
    const res = await checkout(app({ payout: OWN_PAYOUT }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ orderId: makeOrder().id, amount: "58.500000", payout: OWN_PAYOUT });
    // The decimal round-trips to exactly the base units the order was created with.
    expect(parseUsdt(body.amount).toString()).toBe(createOrder.mock.calls[0]![0].amount);
    expect(parseCheckoutSession(body)).toEqual(body);
  });

  it("falls back to the payout of the relayer's createOrder answer when none is configured", async () => {
    const res = await checkout(app());
    expect(res.statusCode).toBe(200);
    expect(res.json().payout).toBe(FIXTURE_PAYOUT);
  });

  it("refuses an order created with a different payout than the configured one", async () => {
    createOrder.mockImplementation(async (o: { amount: string }) => ({ ...makeOrder({ amount: o.amount, fee: "0" }), payout: ATTACKER }));
    const res = await checkout(app({ payout: OWN_PAYOUT }));
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "could not start checkout" });
  });

  it("refuses an order created for a different amount", async () => {
    createOrder.mockImplementation(async () => makeOrder({ amount: "100000000", fee: "0" }));
    expect((await checkout(app({ payout: OWN_PAYOUT }))).statusCode).toBe(502);
  });

  it("refuses an order created for a different merchant", async () => {
    createOrder.mockImplementation(async (o: { amount: string }) => ({ ...makeOrder({ amount: o.amount, fee: "0" }), merchantId: merchantIdFromSlug("attacker-shop") }));
    expect((await checkout(app({ payout: OWN_PAYOUT }))).statusCode).toBe(502);
  });

  it("payout comparison is case-insensitive", async () => {
    const res = await checkout(app({ payout: OWN_PAYOUT.toUpperCase().replace("0X", "0x") as `0x${string}` }));
    expect(res.statusCode).toBe(200);
  });
});

describe("checkout page wiring", () => {
  it("parseCheckoutSession rejects incomplete or malformed answers", () => {
    const ok = { orderId: makeOrder().id, amount: "58.500000", payout: OWN_PAYOUT };
    for (const bad of [
      undefined,
      null,
      { orderId: ok.orderId },
      { ...ok, amount: undefined },
      { ...ok, amount: "1e9" },
      { ...ok, amount: "-1" },
      { ...ok, payout: "" },
      { ...ok, payout: "0x123" },
      { ...ok, orderId: "../x" },
    ]) {
      expect(() => parseCheckoutSession(bad)).toThrow();
    }
    expect(parseCheckoutSession(ok)).toEqual(ok);
  });

  it("the checkout page passes expected-amount and expected-payout from the server's answer to the widget", () => {
    const src = readFileSync(new URL("../src/pages/Checkout.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/expectedAmount=\{session\.amount\}/);
    expect(src).toMatch(/expectedPayout=\{session\.payout\}/);
    expect(src).toMatch(/parseCheckoutSession\(/);
  });

  it(".env.example documents QUIETPAY_PAYOUT_ADDRESS and the server reads it", () => {
    expect(readFileSync(new URL("../.env.example", import.meta.url), "utf8")).toMatch(/^QUIETPAY_PAYOUT_ADDRESS=/m);
    expect(readFileSync(new URL("../server/index.ts", import.meta.url), "utf8")).toMatch(/QUIETPAY_PAYOUT_ADDRESS/);
  });
});
