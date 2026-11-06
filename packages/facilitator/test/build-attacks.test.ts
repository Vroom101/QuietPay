import { describe, it, expect } from "vitest";
import { buildServer } from "@quietpay/relayer/core";
import { registerFacilitator } from "../src/server.js";
import { setup } from "./helpers.js";

const LEAK = /node_modules|\.ts:\d+|stack|[A-Za-z]:\\/;

describe("ATTACK: facilitator routes (combined with the relayer server)", () => {
  async function app() {
    const e = setup();
    const a = buildServer(e.svc);
    await registerFacilitator(a, e.service);
    return { a, e };
  }
  it("verify and settle refuse missing/wrong credentials and leak nothing", async () => {
    const { a, e } = await app();
    for (const url of ["/verify", "/settle"]) {
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Basic abc" }]) {
        const r = await a.inject({ method: "POST", url, payload: await e.request(), headers });
        expect(r.statusCode).toBe(401);
        expect(r.body).not.toMatch(LEAK);
      }
    }
  });
  it("bad JSON and oversize bodies get fixed errors, and the limits exist", async () => {
    const { a } = await app();
    expect(a.initialConfig.bodyLimit).toBeLessThanOrEqual(64 * 1024);
    expect(a.server.requestTimeout).toBeGreaterThan(0);
    expect(a.initialConfig.connectionTimeout).toBeGreaterThan(0);
    const bad = await a.inject({ method: "POST", url: "/settle", headers: { "content-type": "application/json" }, payload: "{oops" });
    const big = await a.inject({ method: "POST", url: "/settle", headers: { "content-type": "application/json" }, payload: JSON.stringify({ p: "x".repeat(80_000) }) });
    expect(big.statusCode).toBe(413);
    for (const r of [bad, big]) {
      expect(r.body).not.toMatch(LEAK);
      expect(r.body).not.toContain("oops");
    }
  });
});
