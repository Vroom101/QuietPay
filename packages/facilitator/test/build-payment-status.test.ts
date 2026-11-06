import { describe, it, expect } from "vitest";
import { buildServer } from "@quietpay/relayer/core";
import { registerFacilitator } from "../src/server.js";
import { setup, payer, nonce, MERCHANT_ID } from "./helpers.js";

// W6: read-only GET /v1/x402/payments/:payer/:nonce for the agent client to resolve unresolved payments.
async function boot(over: Parameters<typeof setup>[0] = {}) {
  const e = setup(over),
    app = buildServer(e.svc);
  await registerFacilitator(app, e.service);
  const get = (payerPart: string, noncePart: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/v1/x402/payments/${payerPart}/${noncePart}`, headers });
  return { e, app, get };
}
const headers = { authorization: "Bearer test-key" };

describe("payment status route", () => {
  it("reports a settled payment with its tx hash and nothing internal", async () => {
    const { e, app, get } = await boot();
    try {
      const req = await e.request(1);
      expect((await e.service.settle(req, MERCHANT_ID)).success).toBe(true);
      const res = await get(payer.address, nonce(1));
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const body = res.json();
      expect(body.status).toBe("settled");
      expect(body.transaction).toMatch(/^0x[0-9a-f]{64}$/);
      expect(Object.keys(body).sort()).toEqual(["network", "status", "transaction"]);
      const text = res.body;
      for (const secret of ["lease", "fingerprint", "signature", "merchant", "request"])
        expect(text.toLowerCase()).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
  it("is public (no API key needed) because the agent has none", async () => {
    const { e, app, get } = await boot();
    try {
      await e.service.settle(await e.request(1), MERCHANT_ID);
      expect((await get(payer.address, nonce(1))).statusCode).toBe(200);
      expect((await get(payer.address, nonce(1), headers)).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
  it("reports pending while settling and failed after a failure, without a hash for failures", async () => {
    const { e, app, get } = await boot();
    try {
      e.state.hold = true;
      e.state.never = true;
      const pending = await e.service.settle(await e.request(2), MERCHANT_ID);
      expect(pending.errorReason).toBe("settlement_pending");
      const p = (await get(payer.address, nonce(2))).json();
      expect(p.status).toBe("pending");
      e.state.never = false;
      e.state.hold = false;
      await e.service.settle(await e.request(3), MERCHANT_ID);
      e.svc.db.raw
        .prepare("UPDATE x402_payments SET status='failed',tx_hash='0x'||hex(randomblob(32)),error_reason='x' WHERE nonce=?")
        .run(nonce(3));
      const f = (await get(payer.address, nonce(3))).json();
      expect(f).toMatchObject({ status: "failed" });
      expect(f.transaction).toBeUndefined();
    } finally {
      await app.close();
    }
  });
  it("answers unknown for a payment it never saw, and for an unresolved one", async () => {
    const { e, app, get } = await boot();
    try {
      const res = await get(payer.address, nonce(99));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "unknown" });
      expect(res.headers["cache-control"]).toBe("no-store");
      await e.service.settle(await e.request(4), MERCHANT_ID);
      e.svc.db.raw.prepare("UPDATE x402_payments SET status='unresolved' WHERE nonce=?").run(nonce(4));
      const u = (await get(payer.address, nonce(4))).json();
      expect(u.status).toBe("unknown");
      expect(u.transaction).toBeUndefined();
    } finally {
      await app.close();
    }
  });
  it.each([
    ["short payer", "0x1234", nonce(1)],
    ["non-hex payer", "0x" + "zz".repeat(20), nonce(1)],
    ["no 0x payer", payer.address.slice(2), nonce(1)],
    ["short nonce", payer.address, "0x01"],
    ["long nonce", payer.address, nonce(1) + "00"],
    ["non-hex nonce", payer.address, "0x" + "g".repeat(64)],
    ["percent-encoded", payer.address, "0x%2e" + "00".repeat(31)],
    ["sql quote", "0x'; DROP TABLE x402_payments;--", nonce(1)],
  ])("rejects malformed params: %s", async (_name, p, n) => {
    const { app, get } = await boot();
    try {
      const res = await get(p, n);
      expect(res.statusCode).toBe(400);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json().error.code).toBe("invalid_payload");
    } finally {
      await app.close();
    }
  });
  it("matches payer and nonce case-insensitively but never leaks another payer's payment", async () => {
    const { e, app, get } = await boot();
    try {
      await e.service.settle(await e.request(5), MERCHANT_ID);
      expect((await get(payer.address.toLowerCase(), nonce(5))).json().status).toBe("settled");
      expect((await get(payer.address, nonce(5).toUpperCase().replace("0X", "0x"))).json().status).toBe("settled");
      const other = "0x" + "11".repeat(20);
      const res = await get(other, nonce(5));
      expect(res.json()).toEqual({ status: "unknown", network: "eip155:1874" });
      // the real payer's hash must not appear anywhere in the answer for someone else
      const real = (await get(payer.address, nonce(5))).json().transaction as string;
      expect(res.body).not.toContain(real);
    } finally {
      await app.close();
    }
  });
  it("rate limits per client and returns 429 with no-store", async () => {
    const { app, get } = await boot({ rateLimitPerMinute: 3 });
    try {
      for (let i = 0; i < 3; i++) expect((await get(payer.address, nonce(7))).statusCode).toBe(200);
      const res = await get(payer.address, nonce(7));
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe("rate_limited");
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
  it("accepts only GET (no write verb reaches the store)", async () => {
    const { app } = await boot();
    try {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
        const res = await app.inject({
          method,
          url: `/v1/x402/payments/${payer.address}/${nonce(1)}`,
          headers,
          payload: {},
        });
        expect([404, 405]).toContain(res.statusCode);
      }
    } finally {
      await app.close();
    }
  });
});
