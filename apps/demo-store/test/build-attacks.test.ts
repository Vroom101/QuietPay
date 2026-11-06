import { afterAll, describe, expect, it } from "vitest";
import { merchantIdFromSlug } from "@quietpay/shared";
import * as sdk from "../server/sdk-stub.js";
import { buildApp } from "../server/app.js";

const LEAK = /node_modules|\.ts:\d+|stack|[A-Za-z]:\\|store-webhook-secret-xyz|store-api-key-secret-xyz/;

const app = buildApp(sdk, {
  baseUrl: "http://127.0.0.1:1",
  apiKey: "store-api-key-secret-xyz",
  merchantId: merchantIdFromSlug("demo-store"),
  webhookSecret: "store-webhook-secret-xyz",
});
afterAll(() => app.close());

describe("ATTACK: demo-store merchant server limits and errors", () => {
  it("has body-size and timeout limits", () => {
    expect(app.initialConfig.bodyLimit).toBeLessThanOrEqual(256 * 1024);
    expect(app.server.requestTimeout).toBeGreaterThan(0);
    expect(app.initialConfig.connectionTimeout).toBeGreaterThan(0);
    expect(app.server.headersTimeout).toBeGreaterThan(0);
  });
  it("an oversize webhook body is refused with 413 and nothing leaks", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/webhooks/quietpay",
      headers: { "content-type": "application/json", "quietpay-signature": "t=1,v1=00" },
      payload: JSON.stringify({ pad: "x".repeat(300 * 1024) }),
    });
    expect(r.statusCode).toBe(413);
    expect(r.body).not.toMatch(LEAK);
  });
  it("an unsigned or badly signed webhook is rejected without echoing a secret", async () => {
    for (const sig of [undefined, "garbage", "t=1,v1=00"]) {
      const r = await app.inject({
        method: "POST",
        url: "/webhooks/quietpay",
        headers: { "content-type": "application/json", ...(sig ? { "quietpay-signature": sig } : {}) },
        payload: "{}",
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(500);
      expect(r.body).not.toMatch(LEAK);
    }
  });
});
