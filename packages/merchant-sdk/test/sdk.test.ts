import { describe, expect, it } from "vitest";
import { signWebhook } from "@quietpay/shared/webhook";
import { orderCreated, webhookSettled, webhookFailed } from "@quietpay/shared/fixtures";
import { QuietpayApiError, WebhookVerificationError, createOrder, getOrder, refund, verifyWebhook } from "../src/index.js";

const secret = "whsec_sdk_test_1234567890";
const merchantId = orderCreated.merchantId as `0x${string}`;

function fakeFetch(status: number, body: unknown, spy?: (url: string, init?: RequestInit) => void): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    spy?.(String(url), init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("createOrder / getOrder", () => {
  it("sends the API key and returns a validated order", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const order = await createOrder({
      baseUrl: "https://relayer.test/",
      apiKey: "k_live",
      merchantId,
      amount: "25000000",
      reference: "cart-1",
      fetch: fakeFetch(201, orderCreated, (url, init) => (seen = { url, init })),
    });
    expect(order.id).toBe(orderCreated.id);
    expect(seen?.url).toBe("https://relayer.test/v1/orders");
    expect((seen?.init?.headers as Record<string, string>).authorization).toBe("Bearer k_live");
    expect(JSON.parse(String(seen?.init?.body))).toMatchObject({ amount: "25000000", reference: "cart-1" });
  });

  it("rejects bad input before any network call", async () => {
    await expect(createOrder({ baseUrl: "x", apiKey: "k", merchantId, amount: "-5", fetch: fakeFetch(201, {}) })).rejects.toThrow();
  });

  it("maps relayer errors to QuietpayApiError with the frozen code", async () => {
    const err = await getOrder({
      baseUrl: "https://relayer.test",
      orderId: orderCreated.id as `0x${string}`,
      fetch: fakeFetch(404, { error: { code: "order_not_found", message: "nope" } }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(QuietpayApiError);
    expect(err.code).toBe("order_not_found");
    expect(err.status).toBe(404);
  });

  it("reads an order without an API key", async () => {
    let init: RequestInit | undefined;
    const o = await getOrder({ baseUrl: "https://r.test", orderId: orderCreated.id as `0x${string}`, fetch: fakeFetch(200, orderCreated, (_u, i) => (init = i)) });
    expect(o.status).toBe("created");
    expect(init?.headers).toBeUndefined();
  });
});

describe("verifyWebhook", () => {
  const body = JSON.stringify(webhookSettled);
  const now = 1_800_000_100;

  it("accepts a correctly signed, fresh event", () => {
    const header = signWebhook(secret, body, now);
    const ev = verifyWebhook({ secret, body, signatureHeader: header, nowSeconds: now + 5 });
    expect(ev.type).toBe("payment.settled");
    expect(ev.id).toBe(webhookSettled.id);
  });

  it("accepts payment.failed", () => {
    const b = JSON.stringify(webhookFailed);
    expect(verifyWebhook({ secret, body: b, signatureHeader: signWebhook(secret, b, now), nowSeconds: now }).type).toBe("payment.failed");
  });

  it("rejects timestamps older than five minutes", () => {
    const header = signWebhook(secret, body, now);
    expect(() => verifyWebhook({ secret, body, signatureHeader: header, nowSeconds: now + 301 })).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook({ secret, body, signatureHeader: header, nowSeconds: now + 299 })).not.toThrow();
  });

  it("rejects a tampered body, wrong secret and missing header", () => {
    const header = signWebhook(secret, body, now);
    expect(() => verifyWebhook({ secret, body: body.replace("25000000", "1"), signatureHeader: header, nowSeconds: now })).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook({ secret: "other-secret-123456", body, signatureHeader: header, nowSeconds: now })).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook({ secret, body, signatureHeader: "", nowSeconds: now })).toThrow(/Missing/);
  });

  it("rejects a validly signed body that is not a Quietpay event", () => {
    const b = JSON.stringify({ hello: "world" });
    expect(() => verifyWebhook({ secret, body: b, signatureHeader: signWebhook(secret, b, now), nowSeconds: now })).toThrow(/not a Quietpay event/);
  });
});

describe("refund stub", () => {
  it("throws until P1", async () => {
    await expect(refund({ baseUrl: "x", apiKey: "k", orderId: orderCreated.id as `0x${string}` })).rejects.toThrow(/P1/);
  });
});
