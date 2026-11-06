import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { MERCHANT_ID, makeEnv } from "./helpers.js";

const MERCHANT_B = ("0x" + "02".repeat(32)) as `0x${string}`;
const KEY_A = "merchant-a-key-0123456789abcdef";
const KEY_B = "merchant-b-key-0123456789abcdef";
const keys = new Map([[KEY_A, MERCHANT_ID], [KEY_B, MERCHANT_B]]);
const list = (app: ReturnType<typeof buildServer>, key: string, ip: string) =>
  app.inject({ url: "/v1/orders", remoteAddress: ip, headers: { authorization: `Bearer ${key}` } });

describe("Feature: order traffic from one merchant server is limited per merchant, not per IP", () => {
  it("Scenario: a valid API key from one IP is not capped at 120 requests per minute", async () => {
    // Given a merchant server behind a single IP with a valid key
    const { svc } = makeEnv({ apiKeys: keys });
    const app = buildServer(svc);
    // When it sends 300 requests in a minute
    let limited = 0;
    for (let i = 0; i < 300; i++) if ((await list(app, KEY_A, "198.51.100.10")).statusCode === 429) limited++;
    // Then none is rate limited (the per-merchant default is 1200/min)
    expect(limited).toBe(0);
  });

  it("Scenario: the per-merchant cap is enforced and configurable", async () => {
    // Given a per-merchant cap of 5 per minute
    const { svc } = makeEnv({ apiKeys: keys, ordersPerMinutePerMerchant: 5 });
    const app = buildServer(svc);
    const codes: number[] = [];
    // When one merchant sends 8 requests
    for (let i = 0; i < 8; i++) codes.push((await list(app, KEY_A, "198.51.100.11")).statusCode);
    // Then the first 5 pass and the rest are 429
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
  });

  it("Scenario: one merchant's flood does not limit another merchant on the same IP", async () => {
    const { svc } = makeEnv({ apiKeys: keys, ordersPerMinutePerMerchant: 5 });
    const app = buildServer(svc);
    for (let i = 0; i < 10; i++) await list(app, KEY_A, "198.51.100.12");
    expect((await list(app, KEY_A, "198.51.100.12")).statusCode).toBe(429);
    expect((await list(app, KEY_B, "198.51.100.12")).statusCode).toBe(200);
  });

  it("Scenario: invalid keys are still throttled per IP (guessing stays blocked)", async () => {
    const { svc } = makeEnv({ apiKeys: keys });
    const app = buildServer(svc);
    let limited = 0;
    for (let i = 0; i < 200; i++) if ((await list(app, `wrong-key-${i}`, "198.51.100.13")).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(50);
    // and a valid key from a different IP is unaffected
    expect((await list(app, KEY_A, "198.51.100.14")).statusCode).toBe(200);
  });

  it("Scenario: a valid key does not become a way around the failed-auth throttle", async () => {
    // Given an IP that already burned its failed-auth budget with junk keys
    const { svc } = makeEnv({ apiKeys: keys });
    const app = buildServer(svc);
    for (let i = 0; i < 40; i++) await list(app, `junk-${i}`, "198.51.100.15");
    // Then a never-seen valid key from that blocked IP is still refused (existing rule, unchanged)
    expect((await list(app, KEY_A, "198.51.100.15")).statusCode).toBe(429);
  });
});
