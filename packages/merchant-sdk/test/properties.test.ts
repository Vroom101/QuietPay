import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { signWebhook } from "@quietpay/shared/webhook";
import { webhookSettled } from "@quietpay/shared/fixtures";
import { QuietpayApiError, WebhookVerificationError, getOrder, verifyWebhook } from "../src/index.js";

// B3 property sweep (fast-check): invariants that must hold for arbitrary input, not just the hand-picked cases.
const NOW = 1_800_000_000;
const secret = fc.string({ minLength: 16, maxLength: 64 }).filter((s) => s.trim() !== "");
const validBody = JSON.stringify(webhookSettled);

describe("webhook verification properties", () => {
  it("a body signed with the secret verifies for any timestamp inside the tolerance", () => {
    fc.assert(
      fc.property(secret, fc.integer({ min: -299, max: 299 }), (s, skew) => {
        const header = signWebhook(s, validBody, NOW + skew);
        expect(verifyWebhook({ secret: s, body: validBody, signatureHeader: header, nowSeconds: NOW }).id).toBe(webhookSettled.id);
      }),
    );
  });

  it("any timestamp outside the tolerance is rejected, whatever the signature", () => {
    fc.assert(
      fc.property(secret, fc.integer({ min: 301, max: 10_000_000 }), fc.boolean(), (s, skew, future) => {
        const header = signWebhook(s, validBody, NOW + (future ? skew : -skew));
        expect(() => verifyWebhook({ secret: s, body: validBody, signatureHeader: header, nowSeconds: NOW })).toThrow(WebhookVerificationError);
      }),
    );
  });

  it("changing any single character of the body invalidates the signature", () => {
    fc.assert(
      fc.property(secret, fc.nat({ max: validBody.length - 1 }), fc.char().filter((c) => c !== ""), (s, at, replacement) => {
        fc.pre(validBody[at] !== replacement);
        const tampered = validBody.slice(0, at) + replacement + validBody.slice(at + 1);
        const header = signWebhook(s, validBody, NOW);
        expect(() => verifyWebhook({ secret: s, body: tampered, signatureHeader: header, nowSeconds: NOW })).toThrow(WebhookVerificationError);
      }),
    );
  });

  it("a signature made with a different secret never verifies", () => {
    fc.assert(
      fc.property(secret, secret, (a, b) => {
        fc.pre(a !== b);
        const header = signWebhook(a, validBody, NOW);
        expect(() => verifyWebhook({ secret: b, body: validBody, signatureHeader: header, nowSeconds: NOW })).toThrow(WebhookVerificationError);
      }),
    );
  });

  it("arbitrary header and body strings only ever produce WebhookVerificationError, never another exception or a pass", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.string({ maxLength: 500 }), (header, body) => {
        try {
          verifyWebhook({ secret: "a-secret-of-sufficient-length", body, signatureHeader: header, nowSeconds: NOW });
          throw new Error("accepted a forged webhook");
        } catch (e) {
          expect(e).toBeInstanceOf(WebhookVerificationError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("garbage tolerance values never silently disable the replay window", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(Number.NaN), fc.constant(Infinity), fc.constant(-Infinity), fc.integer({ max: 0 }), fc.integer({ min: 86_401 })), (tol) => {
        const header = signWebhook("a-secret-of-sufficient-length", validBody, NOW);
        expect(() => verifyWebhook({ secret: "a-secret-of-sufficient-length", body: validBody, signatureHeader: header, nowSeconds: NOW, toleranceSeconds: tol })).toThrow(WebhookVerificationError);
      }),
    );
  });

  it("the duplicate guard runs only after the signature has been proven, with the signed event id", () => {
    fc.assert(
      fc.property(secret, fc.string({ maxLength: 40 }), (s, junk) => {
        let asked = 0;
        const isDuplicate = () => {
          asked++;
          return false;
        };
        try {
          verifyWebhook({ secret: s, body: junk, signatureHeader: "t=1,v1=00", nowSeconds: NOW, isDuplicate });
        } catch {
          /* expected */
        }
        expect(asked).toBe(0);
      }),
    );
  });
});

describe("order id properties", () => {
  it("getOrder never calls the network for an id that is not 0x plus 64 hex characters", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 120 }), async (id) => {
        fc.pre(!/^0x[0-9a-fA-F]{64}$/.test(id));
        let calls = 0;
        const f = (async () => {
          calls++;
          return new Response("{}");
        }) as typeof fetch;
        await expect(getOrder({ baseUrl: "https://relayer.test", orderId: id as `0x${string}`, fetch: f })).rejects.toBeInstanceOf(QuietpayApiError);
        expect(calls).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});
