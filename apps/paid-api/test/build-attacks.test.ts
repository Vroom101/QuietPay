import { describe, it, expect } from "vitest";
import { setup } from "../../../packages/facilitator/test/helpers.js";
import { buildPaidApi } from "../src/app.js";

const LEAK = /node_modules|\.ts:\d+|stack|[A-Za-z]:\\|test-key-secret-123/;

describe("ATTACK: paid API limits and error bodies", () => {
  const make = () => {
    const e = setup();
    return buildPaidApi({ policies: e.policies, facilitatorUrl: "http://127.0.0.1:1", apiKey: "test-key-secret-123" });
  };
  it("has body-size and timeout limits", () => {
    const a = make();
    expect(a.initialConfig.bodyLimit).toBeLessThanOrEqual(64 * 1024);
    expect(a.server.requestTimeout).toBeGreaterThan(0);
    expect(a.initialConfig.connectionTimeout).toBeGreaterThan(0);
    expect(a.server.headersTimeout).toBeGreaterThan(0);
  });
  it("oversize and malformed requests and unknown routes leak no stack, path or key", async () => {
    const a = make();
    const rs = [
      await a.inject({ method: "POST", url: "/v1/quote", headers: { "content-type": "application/json" }, payload: JSON.stringify({ p: "x".repeat(80_000) }) }),
      await a.inject({ method: "POST", url: "/v1/quote", headers: { "content-type": "application/json" }, payload: "{bad" }),
      await a.inject({ url: "/nope/secret.txt" }),
      await a.inject({ url: "/v1/quote", headers: { "payment-signature": "%%%not-base64%%%" } }),
    ];
    for (const r of rs) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.body).not.toMatch(LEAK);
    }
    expect(rs[0]!.statusCode).toBe(413);
  });
  it("health reveals no key", async () => {
    const a = make();
    const r = await a.inject({ url: "/health" });
    expect(r.body).not.toMatch(LEAK);
  });
});
