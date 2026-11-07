import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { loadStoreConfig } from "../server/config.js";

const PAYOUT = "0x" + "22".repeat(20);
const BASE = { QUIETPAY_API_KEY: "k", QUIETPAY_WEBHOOK_SECRET: "s".repeat(32), QUIETPAY_PAYOUT_ADDRESS: PAYOUT };

describe("Feature: demo store settings come from QUIETPAY_* variables", () => {
  it("server/index.ts stays short: it only wires config, SDK and app (20 lines or fewer)", () => {
    const text = readFileSync(fileURLToPath(new URL("../server/index.ts", import.meta.url)), "utf8");
    expect(text.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(20);
  });

  it("maps the variables to the SDK parameters", () => {
    const c = loadStoreConfig({ ...BASE, QUIETPAY_BASE_URL: "http://127.0.0.1:8790", QUIETPAY_MERCHANT_ID: "0x" + "1d".repeat(32), QUIETPAY_BILLING: "product", QUIETPAY_WEBHOOK_URL: "http://127.0.0.1:3001/webhooks/quietpay" });
    expect(c).toMatchObject({ baseUrl: "http://127.0.0.1:8790", apiKey: "k", merchantId: "0x" + "1d".repeat(32), payout: PAYOUT, billing: "one_time", webhookUrl: "http://127.0.0.1:3001/webhooks/quietpay" });
  });

  it("defaults: both billing models, the payout address as the only dashboard wallet, no refunds without a dashboard token", () => {
    const c = loadStoreConfig(BASE);
    expect(c.billing).toBe("both");
    expect(c.merchantAuth?.wallets).toEqual([PAYOUT]);
    expect(c.refunds).toBeUndefined();
  });

  it("enables refunds with the dashboard token and keeps the chain id in both places", () => {
    const c = loadStoreConfig({ ...BASE, QUIETPAY_DASHBOARD_TOKEN: "t".repeat(40), QUIETPAY_ROUTER_ADDRESS: "0x" + "33".repeat(20), QUIETPAY_REFUND_SIGNER_PRIVATE_KEY: "0x" + "44".repeat(32), QUIETPAY_CHAIN_ID: "1874" });
    expect(c.refunds).toMatchObject({ chainId: 1874, tokenDomain: { name: "Tether USD", version: "1" } });
    expect(c.merchantAuth?.chainId).toBe(1874);
  });

  it.each([
    [{ QUIETPAY_WEBHOOK_SECRET: "s" }, /QUIETPAY_API_KEY/],
    [{ QUIETPAY_API_KEY: "k" }, /QUIETPAY_WEBHOOK_SECRET/],
    [{ ...BASE, QUIETPAY_PAYOUT_ADDRESS: "nope" }, /QUIETPAY_PAYOUT_ADDRESS/],
    [{ ...BASE, QUIETPAY_MERCHANT_WALLETS: "0x1" }, /QUIETPAY_MERCHANT_WALLETS/],
    [{ ...BASE, QUIETPAY_BILLING: "monthly" }, /QUIETPAY_BILLING/],
  ])("fails fast with a clear message for %j", (env, message) => {
    expect(() => loadStoreConfig(env as never)).toThrow(message);
  });

  it("warns, but still starts, when no payout address is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = loadStoreConfig({ QUIETPAY_API_KEY: "k", QUIETPAY_WEBHOOK_SECRET: "s".repeat(32) });
    expect(c.payout).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
