import { describe, expect, it } from "vitest";
import { makeOrder } from "@quietpay/shared/fixtures";
import { createQuietPay, QuietpayConfigError } from "../src/index.js";

const MERCHANT = "0x" + "1d".repeat(32);
const ENV = {
  QUIETPAY_BASE_URL: "http://relayer.test/",
  QUIETPAY_API_KEY: "key-from-env",
  QUIETPAY_MERCHANT_ID: MERCHANT,
  QUIETPAY_WEBHOOK_SECRET: "s".repeat(32),
};

function spy() {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body });
    return Response.json(makeOrder({ merchantId: MERCHANT as `0x${string}`, amount: body.amount, reference: body.reference }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("Feature: createQuietPay() starts from the environment with no arguments", () => {
  it("reads base url, API key, merchant id and billing from QUIETPAY_* variables", async () => {
    const { f, calls } = spy();
    const qp = createQuietPay({ env: { ...ENV, QUIETPAY_BILLING: "product" }, fetch: f });
    expect(qp.billing).toBe("one_time");
    await qp.createOrder({ amount: "8500000" });
    expect(calls[0]).toMatchObject({ url: "http://relayer.test/v1/orders", auth: "Bearer key-from-env" });
    expect(calls[0]!.body).toMatchObject({ merchantId: MERCHANT, amount: "8500000" });
  });

  it("defaults to one-time billing and passes QUIETPAY_WEBHOOK_URL to every order", async () => {
    const { f, calls } = spy();
    const qp = createQuietPay({ env: { ...ENV, QUIETPAY_WEBHOOK_URL: "https://shop.example/hook" }, fetch: f });
    expect(qp.billing).toBe("one_time");
    await qp.createOrder({ amount: "1000000" });
    expect(calls[0]!.body.webhookUrl).toBe("https://shop.example/hook");
  });

  it("uses QUIETPAY_WEBHOOK_SECRET so verifyWebhook needs no secret argument", () => {
    const qp = createQuietPay({ env: ENV });
    expect(() => qp.verifyWebhook({ body: "{}", signatureHeader: "t=1,v1=bad" })).toThrow(/signature/i);
  });

  it("an explicit option beats the environment", async () => {
    const { f, calls } = spy();
    const qp = createQuietPay({ env: ENV, apiKey: "explicit-key", billing: "both", fetch: f });
    expect(qp.billing).toBe("both");
    await qp.createOrder({ amount: "1" });
    expect(calls[0]!.auth).toBe("Bearer explicit-key");
  });

  it("reads QUIETPAY_BILLING=subscription and refuses one-time orders", () => {
    const qp = createQuietPay({ env: { ...ENV, QUIETPAY_BILLING: "subscription" } });
    expect(qp.supports).toEqual({ oneTime: false, subscription: true });
  });

  it("names EVERY missing variable in one error, and treats empty values as missing", () => {
    let message = "";
    try { createQuietPay({ env: { QUIETPAY_BASE_URL: "", QUIETPAY_API_KEY: "  " } }); } catch (e) { message = (e as Error).message; expect((e as Error).name).toBe("QuietpayConfigError"); }
    for (const name of ["QUIETPAY_BASE_URL", "QUIETPAY_API_KEY", "QUIETPAY_MERCHANT_ID"]) expect(message).toContain(name);
    expect(message).not.toContain("QUIETPAY_WEBHOOK_SECRET"); // optional until you verify webhooks
  });

  it("rejects an invalid QUIETPAY_BILLING or merchant id with a clear message", () => {
    expect(() => createQuietPay({ env: { ...ENV, QUIETPAY_BILLING: "monthly" } })).toThrow(/billing/);
    expect(() => createQuietPay({ env: { ...ENV, QUIETPAY_MERCHANT_ID: "0x12" } })).toThrow(/merchantId|QUIETPAY_MERCHANT_ID/);
    expect(() => createQuietPay({ env: { ...ENV, QUIETPAY_BASE_URL: "not a url" } })).toThrow(QuietpayConfigError);
  });

  it("falls back to process.env when no env object is given", () => {
    const saved = { ...process.env };
    Object.assign(process.env, ENV);
    try {
      expect(createQuietPay().billing).toBe("one_time");
    } finally {
      for (const k of Object.keys(ENV)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
});
