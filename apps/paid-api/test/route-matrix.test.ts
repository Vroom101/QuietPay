import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildPaidApi } from "../src/app.js";
import { setup } from "../../../packages/facilitator/test/helpers.js";

// B2.4: route-by-route security matrix for the paid API (docs/b/route-matrix.md). All three routes are public GETs;
// the two paid ones sit behind the x402 paywall, so "authentication" here means the PAYMENT-SIGNATURE header.
const ROUTES = ["/health", "/v1/quote", "/v1/signal"] as const;
const LEAKS = [/\bat [^\n]*\(.*:\d+:\d+\)/, /node_modules/, /[A-Za-z]:\\/, /\/(home|Users|usr|app)\//, /process\.env/i, /stack/i, /secret-api-key/];
const clean = (body: string, what: string) => {
  for (const re of LEAKS) expect(body, `${what} leaked ${re}`).not.toMatch(re);
};

let app: FastifyInstance;
beforeAll(async () => {
  const e = setup();
  // The facilitator is unreachable on purpose: none of these requests may need it.
  app = buildPaidApi({
    policies: e.policies,
    facilitatorUrl: "http://127.0.0.1:1",
    apiKey: "secret-api-key",
    fetch: (async () => {
      throw new Error("facilitator offline");
    }) as typeof fetch,
  });
  await app.ready();
});
afterAll(() => app.close());

describe("paid-api route matrix", () => {
  for (const path of ROUTES) {
    it(`${path}: wrong methods give 404/405 with a clean body`, async () => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
        const res = await app.inject(method === "DELETE" ? { method, url: path } : { method, url: path, payload: "{}", headers: { "content-type": "application/json" } });
        expect([404, 405], `${method} ${path}`).toContain(res.statusCode);
        clean(res.body, `${method} ${path}`);
      }
    });
  }

  it("an unknown path gives a fixed 404 that does not echo the requested path", async () => {
    const res = await app.inject({ method: "GET", url: "/nope/<script>alert(1)</script>" });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("script");
    expect(res.body).not.toContain("nope");
    expect(JSON.parse(res.body).error.code).toBe("not_found");
  });

  for (const path of ["/v1/quote", "/v1/signal"]) {
    it(`${path}: no payment gives a 402 challenge, never the resource`, async () => {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(402);
      expect(res.body).not.toContain("paid-data");
      clean(res.body, path);
    });

    const headers: [string, string][] = [
      ["not base64", "%%%not-base64%%%"],
      ["base64 but not JSON", Buffer.from("hello").toString("base64")],
      ["JSON array", Buffer.from("[1,2,3]").toString("base64")],
      ["__proto__ key", Buffer.from('{"__proto__":{"admin":true},"x402Version":2}').toString("base64")],
      ["deeply nested", Buffer.from("[".repeat(3000) + "]".repeat(3000)).toString("base64")],
      ["empty", ""],
    ];
    for (const [what, value] of headers) {
      it(`${path}: PAYMENT-SIGNATURE ${what} gets a 4xx challenge with a clean body`, async () => {
        const res = await app.inject({ method: "GET", url: path, headers: { "payment-signature": value } });
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
        clean(res.body, `${path} ${what}`);
      });
    }

    it(`${path}: a request body on a GET is ignored or rejected with 4xx, never echoed`, async () => {
      const res = await app.inject({ method: "GET", url: path, payload: JSON.stringify({ secret: "echo-me" }), headers: { "content-type": "application/json" } });
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain("echo-me");
    });
  }

  it("an oversized body is rejected with 413 and a fixed JSON error", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: JSON.stringify({ pad: "x".repeat(20 * 1024) }), headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe("invalid_request");
    clean(res.body, "oversized");
  });

  it("malformed JSON on an unsupported method gives a stable JSON error", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/quote", payload: "{not json", headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(typeof JSON.parse(res.body).error.code).toBe("string");
    clean(res.body, "malformed");
  });

  it("CORS never allows credentials, and OPTIONS is answered without touching the facilitator", async () => {
    for (const path of ROUTES) {
      const get = await app.inject({ method: "GET", url: path, headers: { origin: "https://evil.example" } });
      expect(get.headers["access-control-allow-credentials"]).toBeUndefined();
      const pre = await app.inject({ method: "OPTIONS", url: path, headers: { origin: "https://evil.example" } });
      expect(pre.statusCode).toBe(204);
      expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(String(pre.headers["access-control-allow-headers"]).toLowerCase()).not.toContain("authorization");
    }
  });

  it("the HTTP server has request and headers timeouts", () => {
    expect(app.server.requestTimeout).toBeGreaterThan(0);
    expect(app.server.requestTimeout).toBeLessThanOrEqual(60_000);
    expect(app.server.headersTimeout).toBeGreaterThan(0);
  });
});

describe("paid-api unexpected failures", () => {
  it("an unexpected internal error becomes a fixed 500 that leaks nothing", async () => {
    const e = setup();
    const broken = buildPaidApi({ policies: e.policies, facilitatorUrl: "http://127.0.0.1:1", apiKey: "secret-api-key" });
    broken.addHook("preHandler", async () => {
      throw new Error("db at C:\secret\path exploded with secret-api-key");
    });
    const res = await broken.inject({ method: "GET", url: "/health" });
    await broken.close();
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: { code: "resource_unavailable", message: "Something went wrong on our side." } });
    clean(res.body, "500");
  });
});

