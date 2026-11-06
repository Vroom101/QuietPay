import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { MERCHANT_ID, ROUTER, makeEnv } from "./helpers.js";

const smoke = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "deploy", "smoke.mjs");
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function run(env: Record<string, string>, over: { paused?: boolean } = {}) {
  const e = makeEnv();
  if (over.paused) e.chain.paused = true;
  app = buildServer(e.svc);
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  // spawnSync would block the server's event loop, so use the async form.
  const { spawn } = await import("node:child_process");
  return new Promise<{ code: number | null; out: string }>((res) => {
    const p = spawn(process.execPath, [smoke], { env: { PATH: process.env.PATH ?? "", SMOKE_BASE_URL: url, SMOKE_MERCHANT_ID: MERCHANT_ID, SMOKE_ROUTER: ROUTER, SMOKE_API_KEY: "test-key", ...env } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("exit", (code) => res({ code, out }));
  });
}

describe("Feature: deploy/smoke.mjs / Scenario: against a local relayer", () => {
  it("Given a healthy relayer, When the smoke runs, Then every check passes", async () => {
    const r = await run({});
    expect(r.out).toContain("smoke: all checks passed");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("test-key");
  });
  it("Given the wrong router is expected, Then the smoke fails on health", async () => {
    const r = await run({ SMOKE_ROUTER: "0x" + "99".repeat(20) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL\s+health/);
  });
  it("Given a wrong API key in the environment, Then order creation fails", async () => {
    const r = await run({ SMOKE_API_KEY: "wrong-wrong-wrong-wrong-wrong" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL\s+create an order/);
  });
  it("Given the relayer is paused, Then the smoke fails on health", async () => {
    const r = await run({}, { paused: true });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/paused is true/);
  });
  it("Given no configuration, Then it exits 2 with a usage message", () => {
    const r = spawnSync(process.execPath, [smoke], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});
