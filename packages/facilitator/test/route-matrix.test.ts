import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "@quietpay/relayer/core";
import { registerFacilitator } from "../src/server.js";
import { setup } from "./helpers.js";

// B2.4: route-by-route security matrix for the combined relayer + facilitator app (docs/b/route-matrix.md).
// Each case uses its own client address so the failed-auth limiter of one case cannot affect another.
type Route = { method: "GET" | "POST"; path: string; auth: "none" | "merchant" | "operator"; body?: boolean };
const ID = "0x" + "ab".repeat(32);
const ROUTES: Route[] = [
  { method: "GET", path: "/v1/health", auth: "none" },
  { method: "POST", path: "/v1/orders", auth: "merchant", body: true },
  { method: "GET", path: "/v1/orders", auth: "merchant" },
  { method: "GET", path: `/v1/orders/${ID}`, auth: "none" },
  { method: "POST", path: "/v1/relay/pay", auth: "none", body: true },
  { method: "GET", path: `/v1/orders/${ID}/refund-context`, auth: "merchant" },
  { method: "GET", path: `/v1/orders/${ID}/refunds`, auth: "merchant" },
  { method: "POST", path: "/v1/relay/refund", auth: "merchant", body: true },
  { method: "GET", path: `/v1/refunds/${ID}`, auth: "merchant" },
  { method: "GET", path: "/v1/metrics", auth: "operator" },
  { method: "POST", path: "/v1/admin/pause", auth: "operator", body: true },
  { method: "GET", path: "/supported", auth: "none" },
  { method: "POST", path: "/verify", auth: "merchant", body: true },
  { method: "POST", path: "/settle", auth: "merchant", body: true },
  { method: "POST", path: "/v1/x402/delivery/claim", auth: "merchant", body: true },
  { method: "POST", path: "/v1/x402/delivery/complete", auth: "merchant", body: true },
  { method: "POST", path: "/v1/x402/delivery/release", auth: "merchant", body: true },
  { method: "POST", path: "/v1/x402/delivery/renew", auth: "merchant", body: true },
];
const creds = { merchant: "Bearer test-key", operator: "Bearer operator-token-123456" } as const;

let n = 0;
const nextIp = () => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${++n & 255}`;
const LEAKS = [/\bat [^\n]*\(.*:\d+:\d+\)/, /node_modules/, /[A-Za-z]:\\/, /\/(home|Users|usr|app)\//, /process\.env/i, /stack/i, /test-key/, /operator-token/];
function expectClean(body: string, what: string) {
  for (const re of LEAKS) expect(body, `${what} leaked ${re}`).not.toMatch(re);
}
function expectStableShape(res: { statusCode: number; body: string; headers: Record<string, unknown> }, what: string) {
  expect(res.statusCode, what).toBeGreaterThanOrEqual(400);
  expect(res.statusCode, what).toBeLessThan(500);
  expect(String(res.headers["content-type"]), what).toContain("application/json");
  const j = JSON.parse(res.body);
  const okShape =
    (typeof j?.error?.code === "string" && typeof j?.error?.message === "string") ||
    (j?.isValid === false && typeof j?.invalidReason === "string") ||
    (j?.success === false && typeof j?.errorReason === "string");
  expect(okShape, `${what}: unstable error shape ${res.body}`).toBe(true);
  expectClean(res.body, what);
}

let app: FastifyInstance;
beforeAll(async () => {
  const e = setup();
  app = buildServer(e.svc);
  await registerFacilitator(app, e.service);
  await app.ready();
});
afterAll(() => app.close());

const call = (r: Route, o: { headers?: Record<string, string>; payload?: unknown; method?: string; path?: string } = {}) =>
  app.inject({
    method: (o.method ?? r.method) as "GET",
    url: o.path ?? r.path,
    remoteAddress: nextIp(),
    headers: o.headers,
    payload: o.payload as string,
  });
const authed = (r: Route, extra: Record<string, string> = {}): Record<string, string> => ({ ...(r.auth === "none" ? {} : { authorization: creds[r.auth] }), ...extra });
const label = (r: Route) => `${r.method} ${r.path.replace(ID, ":id")}`;

describe("route matrix: authentication", () => {
  for (const r of ROUTES.filter((x) => x.auth !== "none")) {
    it(`${label(r)} refuses missing and wrong credentials`, async () => {
      for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "Basic abc" }, { authorization: "" }] as Record<string, string>[]) {
        const res = await call(r, { headers, payload: r.body ? {} : undefined });
        expect([401, 403], `${r.path} with ${JSON.stringify(headers)} gave ${res.statusCode}`).toContain(res.statusCode);
        expectClean(res.body, r.path);
      }
    });
  }
  it("a merchant key is not an operator token", async () => {
    for (const r of ROUTES.filter((x) => x.auth === "operator")) {
      const res = await call(r, { headers: { authorization: creds.merchant }, payload: r.body ? {} : undefined });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("route matrix: methods and unknown routes", () => {
  for (const r of ROUTES) {
    it(`wrong method on ${r.path.replace(ID, ":id")} gives 404/405 with a clean body`, async () => {
      const wrong = r.method === "GET" ? "DELETE" : "PUT";
      const res = await call(r, { method: wrong, headers: authed(r) });
      expect([404, 405]).toContain(res.statusCode);
      expectClean(res.body, "wrong method");
    });
  }
  it("an unknown path gives a fixed 404 that does not echo the requested path", async () => {
    const probe = "/does/not/exist/<script>alert(1)</script>";
    const res = await call(ROUTES[0]!, { path: probe });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("script");
    expect(res.body).not.toContain("does/not/exist");
    expect(JSON.parse(res.body).error.code).toBe("not_found");
  });
});

describe("route matrix: request bodies", () => {
  for (const r of ROUTES.filter((x) => x.body)) {
    it(`${label(r)}: oversized body is rejected with 413`, async () => {
      const res = await call(r, {
        headers: authed(r, { "content-type": "application/json" }),
        payload: JSON.stringify({ pad: "x".repeat(20 * 1024) }),
      });
      expect(res.statusCode).toBe(413);
      expectClean(res.body, label(r));
    });
    const cases: [string, Record<string, string>, string][] = [
      ["malformed JSON", { "content-type": "application/json" }, "{not json"],
      ["wrong content type", { "content-type": "text/plain" }, "hello"],
      ["array body", { "content-type": "application/json" }, "[1,2,3]"],
      ["__proto__ key", { "content-type": "application/json" }, '{"__proto__":{"admin":true}}'],
      ["deep nesting", { "content-type": "application/json" }, "[".repeat(3000) + "]".repeat(3000)],
    ];
    for (const [what, headers, payload] of cases) {
      it(`${label(r)}: ${what} gives a 4xx with a stable, clean error`, async () => {
        const res = await call(r, { headers: authed(r, headers), payload });
        expectStableShape(res, `${label(r)} ${what}`);
      });
    }
  }
});

describe("route matrix: CORS", () => {
  const origin = "https://evil.example";
  for (const r of ROUTES.filter((x) => x.auth !== "none")) {
    it(`${label(r)} (authenticated) never answers with a wildcard or reflected origin`, async () => {
      const res = await call(r, { headers: authed(r, { origin }), payload: r.body ? {} : undefined });
      expect(res.headers["access-control-allow-origin"]).not.toBe("*");
      const pre = await call(r, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": r.method, "access-control-request-headers": "authorization" },
      });
      expect(pre.headers["access-control-allow-origin"]).not.toBe("*");
      expect(pre.headers["access-control-allow-origin"]).not.toBe(origin);
    });
  }
  for (const r of ROUTES.filter((x) => x.auth === "none")) {
    it(`${label(r)} (public) stays callable from any origin`, async () => {
      const res = await call(r, { method: "OPTIONS", headers: { origin } });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  }
});

describe("route matrix: timeouts", () => {
  it("the HTTP server has a request timeout and a headers timeout set", () => {
    expect(app.server.requestTimeout).toBeGreaterThan(0);
    expect(app.server.requestTimeout).toBeLessThanOrEqual(60_000);
    expect(app.server.headersTimeout).toBeGreaterThan(0);
  });
});

describe("route matrix: facilitator rate limit follows the trusted-proxy setting (round B finding RB-8)", () => {
  async function limited(hops: number) {
    const e = setup({ rateLimitPerMinute: 3, trustProxyHops: hops });
    const a = buildServer(e.svc);
    await registerFacilitator(a, e.service);
    await a.ready();
    const hit = (xff: string) =>
      a.inject({ method: "POST", url: "/verify", remoteAddress: "10.0.0.1", headers: { authorization: "Bearer test-key", "x-forwarded-for": xff, "content-type": "application/json" }, payload: "{}" });
    return { a, hit };
  }
  it("behind one trusted proxy, one noisy client does not exhaust the limit of other clients", async () => {
    const { a, hit } = await limited(1);
    for (let i = 0; i < 6; i++) await hit("198.51.100.1");
    expect((await hit("198.51.100.1")).statusCode).toBe(429);
    expect((await hit("198.51.100.2")).statusCode).not.toBe(429);
    await a.close();
  });
  it("with no trusted proxy, a spoofed X-Forwarded-For buys no extra budget", async () => {
    const { a, hit } = await limited(0);
    for (let i = 0; i < 3; i++) await hit(`203.0.113.${i}`);
    expect((await hit("203.0.113.99")).statusCode).toBe(429);
    await a.close();
  });
});

describe("route matrix: caches cannot mix up CORS answers (round C F5)", () => {
  it("every response varies on Origin", async () => {
    for (const r of [{ m: "GET", u: "/supported" }, { m: "GET", u: "/v1/metrics" }, { m: "POST", u: "/verify" }, { m: "GET", u: "/nope" }]) {
      const res = await app.inject({ method: r.m as "GET", url: r.u, remoteAddress: nextIp(), headers: { origin: "https://x.example" } });
      expect(String(res.headers.vary).toLowerCase(), r.u).toContain("origin");
    }
  });
});
