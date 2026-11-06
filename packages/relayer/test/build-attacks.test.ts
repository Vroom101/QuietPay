import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { makeEnv, newOrder } from "./helpers.js";

const SECRETS = ["operator-token-123456", "test-key", "whsec_test_secret_123456", "b2".repeat(32), "http://localhost:8545"];
const NO_LEAK = [/node_modules/, /\.ts:\d+/, /\.js:\d+/, /\bat \S+ \(/, /[A-Za-z]:\\/, /\/home\//, /\/app\//, /stack/i, /SQLITE/i, /better-sqlite3/i];

function assertClean(body: string) {
  for (const s of SECRETS) expect(body).not.toContain(s);
  for (const re of NO_LEAK) expect(body).not.toMatch(re);
}

describe("ATTACK: operator surface needs the operator token", () => {
  const requests: { name: string; method: "GET" | "POST"; url: string; headers?: Record<string, string>; payload?: unknown }[] = [
    { name: "metrics, no credentials", method: "GET", url: "/v1/metrics" },
    { name: "metrics, merchant key instead of operator token", method: "GET", url: "/v1/metrics", headers: { authorization: "Bearer test-key" } },
    { name: "metrics, token in query string", method: "GET", url: "/v1/metrics?token=operator-token-123456" },
    { name: "metrics, token in a custom header", method: "GET", url: "/v1/metrics", headers: { "x-operator-token": "operator-token-123456" } },
    { name: "metrics, Basic scheme", method: "GET", url: "/v1/metrics", headers: { authorization: "Basic operator-token-123456" } },
    { name: "metrics, lowercase bearer scheme", method: "GET", url: "/v1/metrics", headers: { authorization: "bearer operator-token-123456" } },
    { name: "metrics, token with one wrong char", method: "GET", url: "/v1/metrics", headers: { authorization: "Bearer operator-token-123457" } },
    { name: "metrics, token prefix", method: "GET", url: "/v1/metrics", headers: { authorization: "Bearer operator-token" } },
    { name: "pause, no credentials", method: "POST", url: "/v1/admin/pause", payload: { paused: true } },
    { name: "pause, merchant key", method: "POST", url: "/v1/admin/pause", payload: { paused: true }, headers: { authorization: "Bearer test-key" } },
    { name: "pause, wrong token", method: "POST", url: "/v1/admin/pause", payload: { paused: false }, headers: { authorization: "Bearer nope" } },
    { name: "metrics with a trailing slash", method: "GET", url: "/v1/metrics/" },
    { name: "admin path case variant", method: "POST", url: "/V1/ADMIN/pause", payload: { paused: true } },
    { name: "admin path with a dot segment", method: "POST", url: "/v1/orders/../admin/pause", payload: { paused: true } },
  ];
  it.each(requests)("refused: $name", async ({ method, url, headers, payload }) => {
    const { svc } = makeEnv();
    const app = buildServer(svc);
    const res = await app.inject({ method, url, headers, payload: payload as never });
    expect([401, 404, 429]).toContain(res.statusCode);
    expect(res.body).not.toContain("balanceWbt");
    expect(res.body).not.toContain('"paused":true');
    expect(await svc.health()).toMatchObject({ paused: false }); // nothing was paused
    assertClean(res.body);
  });

  it("other admin paths do not exist", async () => {
    const { svc } = makeEnv();
    const app = buildServer(svc);
    for (const url of ["/v1/admin", "/v1/admin/", "/v1/admin/keys", "/v1/admin/orders", "/admin", "/metrics", "/v1/debug"]) {
      const res = await app.inject({ url, headers: { authorization: "Bearer operator-token-123456" } });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(url.replace(/^\//, "")); // the path is not echoed
    }
  });
});

describe("ATTACK: error bodies leak nothing", () => {
  it("malformed, oversized and mistyped requests get fixed bodies", async () => {
    const { svc } = makeEnv();
    const app = buildServer(svc);
    const bodies = [
      await app.inject({ method: "POST", url: "/v1/relay/pay", headers: { "content-type": "application/json" }, payload: "{not json" }),
      await app.inject({ method: "POST", url: "/v1/relay/pay", headers: { "content-type": "text/plain" }, payload: "x" }),
      await app.inject({ method: "POST", url: "/v1/relay/pay", headers: { "content-type": "application/json" }, payload: JSON.stringify({ a: "x".repeat(20_000) }) }),
      await app.inject({ method: "POST", url: "/v1/relay/pay", payload: { orderId: { $ne: 1 } } as never }),
      await app.inject({ url: "/v1/orders/%00%ff" }),
      await app.inject({ url: "/v1/orders/" + "a".repeat(5000) }),
      await app.inject({ url: "/does/not/exist/C:\\secret.txt" }),
      await app.inject({ method: "DELETE", url: "/v1/orders" }),
    ];
    for (const r of bodies) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(600);
      assertClean(r.body);
      expect(r.body).not.toContain("secret.txt");
    }
    expect(bodies[2]!.statusCode).toBe(413);
  });

  it("an unexpected internal exception becomes a generic 500 with no message, stack, path or secret", async () => {
    const { svc } = makeEnv();
    (svc as unknown as { createOrder: () => never }).createOrder = () => {
      throw new Error("boom at C:\\Users\\ops\\quietpay\\src\\service.ts:42 key=test-key token=operator-token-123456 SQLITE_CORRUPT");
    };
    const app = buildServer(svc);
    const res = await app.inject({
      method: "POST",
      url: "/v1/orders",
      headers: { authorization: "Bearer test-key" },
      payload: { merchantId: "0x" + "01".repeat(32), amount: "1000000" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "simulation_failed", message: "Something went wrong on our side." } });
    assertClean(res.body);
    expect(res.body).not.toContain("boom");
  });

  it("an unknown order and a bad API key give fixed bodies", async () => {
    const { svc } = makeEnv();
    const app = buildServer(svc);
    const a = await app.inject({ url: "/v1/orders/0x" + "ee".repeat(32) });
    const b = await app.inject({ url: "/v1/orders", headers: { authorization: "Bearer wrong-key-wrong-key-wrong" } });
    for (const r of [a, b]) assertClean(r.body);
    expect(b.json().error.message).toBe("Invalid API key.");
  });
});

describe("ATTACK: health reveals no secret", () => {
  it("the public health document carries only chain facts", async () => {
    const { svc, cfg } = makeEnv({ databasePath: "/data/quietpay.db" });
    const app = buildServer(svc);
    const res = await app.inject({ url: "/v1/health" });
    expect(res.statusCode).toBe(200);
    assertClean(res.body);
    expect(res.body).not.toContain("/data/quietpay.db");
    expect(Object.keys(res.json()).sort()).toEqual(["blockNumber", "chainId", "ok", "paused", "relayer", "router", "token"]);
    expect(res.json().router).toBe(cfg.router);
    // And the metrics document (operator only) still carries no key material.
    const m = await app.inject({ url: "/v1/metrics", headers: { authorization: "Bearer operator-token-123456" } });
    for (const s of SECRETS) expect(m.body).not.toContain(s);
    // order bodies do not carry the webhook master secret or API keys either
    const o = await newOrder(svc);
    const ob = await app.inject({ url: `/v1/orders/${o.id}` });
    for (const s of SECRETS) expect(ob.body).not.toContain(s);
  });
});

describe("ATTACK: request limits exist on the server", () => {
  it("body limit, request timeout, connection timeout and headers timeout are set", () => {
    const { svc } = makeEnv();
    const app = buildServer(svc);
    expect(app.initialConfig.bodyLimit).toBeLessThanOrEqual(64 * 1024);
    expect(app.initialConfig.requestTimeout).toBeGreaterThan(0);
    expect(app.initialConfig.requestTimeout).toBeLessThanOrEqual(60_000);
    expect(app.initialConfig.connectionTimeout).toBeGreaterThan(0);
    expect(app.server.headersTimeout).toBeGreaterThan(0);
    expect(app.server.headersTimeout).toBeLessThanOrEqual(30_000);
  });

  it("a body over the limit is refused with 413 before any handler runs", async () => {
    const { svc, chain } = makeEnv();
    const app = buildServer(svc);
    const res = await app.inject({
      method: "POST",
      url: "/v1/relay/pay",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ pad: "x".repeat(70 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(chain.sent).toHaveLength(0);
  });
});

describe("ATTACK: spoofed X-Forwarded-For", () => {
  const hit = (app: ReturnType<typeof buildServer>, xff?: string) =>
    app.inject({ url: "/v1/health", headers: xff ? { "x-forwarded-for": xff } : {} });

  it("without TRUST_PROXY_HOPS a rotating spoofed header does not reset the health rate limit", async () => {
    const { svc } = makeEnv({ trustProxyHops: 0 });
    const app = buildServer(svc);
    let limited = 0;
    for (let i = 0; i < 90; i++) {
      const r = await hit(app, `203.0.113.${i % 250},198.51.100.${i % 250}`);
      if (r.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThanOrEqual(25); // 60 per minute, then everything from the one socket address is limited
  });

  it("without TRUST_PROXY_HOPS spoofed headers do not reset the failed-auth throttle", async () => {
    const { svc } = makeEnv({ trustProxyHops: 0 });
    const app = buildServer(svc);
    let throttled = 0;
    for (let i = 0; i < 30; i++) {
      const r = await app.inject({ url: "/v1/metrics", headers: { authorization: `Bearer guess-${i}-xxxxxxxxxxxxxxxx`, "x-forwarded-for": `10.9.${i}.1` } });
      if (r.statusCode === 429) throttled += 1;
    }
    expect(throttled).toBeGreaterThan(0);
  });

  it("with TRUST_PROXY_HOPS=1 only the proxy-appended entry counts: client-supplied entries to its left are ignored", async () => {
    const { svc } = makeEnv({ trustProxyHops: 1 });
    const app = buildServer(svc);
    let limited = 0;
    for (let i = 0; i < 90; i++) {
      // The client forges everything on the left; the trusted proxy appended the real client (the same every time).
      const r = await hit(app, `203.0.113.${i % 250}, 198.51.100.77`);
      if (r.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThanOrEqual(25);
  });

  it("with TRUST_PROXY_HOPS=1 distinct clients behind the proxy are limited separately", async () => {
    const { svc } = makeEnv({ trustProxyHops: 1 });
    const app = buildServer(svc);
    for (let i = 0; i < 80; i++) expect((await hit(app, `198.51.100.${i + 1}`)).statusCode).toBe(200);
  });
});
