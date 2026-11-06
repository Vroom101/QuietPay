import { describe, expect, it } from "vitest";
import { buildServer } from "../../src/api/server.js";
import { makeEnv, MERCHANT } from "./helpers.js";

const KEY = "merchant-key-secret-123456";
const LEAK = /node_modules|\.ts:\d+|stack|[A-Za-z]:\\|merchant-key-secret-123456|SQLITE/i;

describe("ATTACK: indexer merchant-ledger API", () => {
  const make = () => buildServer(makeEnv().indexer, new Map([[KEY, MERCHANT]]));
  it("has body-size and timeout limits", () => {
    const a = make();
    expect(a.initialConfig.bodyLimit).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(a.server.requestTimeout).toBeGreaterThan(0);
    expect(a.initialConfig.connectionTimeout).toBeGreaterThan(0);
    expect(a.server.headersTimeout).toBeGreaterThan(0);
  });
  it("ledger reads and verification need a valid merchant key", async () => {
    const a = make();
    for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: "Basic " + KEY }]) {
      for (const url of ["/v1/ledger", "/v1/ledger/export"]) expect((await a.inject({ url, headers })).statusCode).toBe(401);
      expect((await a.inject({ method: "POST", url: "/v1/ledger/verify", headers, payload: {} })).statusCode).toBe(401);
    }
  });
  it("an oversize body is refused and error bodies leak nothing", async () => {
    const a = make();
    const hdr = { authorization: "Bearer " + KEY, "content-type": "application/json" };
    const big = await a.inject({ method: "POST", url: "/v1/ledger/verify", headers: hdr, payload: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024 + 10) }) });
    expect(big.statusCode).toBe(413);
    const rs = [
      big,
      await a.inject({ method: "POST", url: "/v1/ledger/verify", headers: hdr, payload: "{bad" }),
      await a.inject({ url: "/nope/secret.txt" }),
      await a.inject({ url: "/v1/health" }),
    ];
    for (const r of rs) expect(r.body).not.toMatch(LEAK);
  });
});
