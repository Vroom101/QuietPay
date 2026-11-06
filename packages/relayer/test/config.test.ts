import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { makeCfg, MERCHANT_ID } from "./helpers.js";

const cfg = makeCfg();
const env = {
  RPC_URL: cfg.rpcUrl, USDT_ADDRESS: cfg.usdt, ROUTER_ADDRESS: cfg.router,
  RELAYER_PRIVATE_KEY: cfg.relayerKey, OPERATOR_TOKEN: cfg.operatorToken,
  MERCHANT_API_KEYS: `test:${MERCHANT_ID}`, WEBHOOK_SECRET: cfg.webhookSecret,
};

describe("P0 configuration", () => {
  it("loads bounded recovery defaults", () => {
    expect(loadConfig(env)).toMatchObject({ maxGasLimit: 500_000n, pendingRetrySeconds: 30,
      maxReplacements: 3, lowBalanceWei: 10n ** 16n });
  });
  it("accepts explicit safety settings", () => {
    expect(loadConfig({ ...env, MAX_GAS_LIMIT: "250000", MAX_GAS_PRICE: "1000000000",
      MAX_REPLACEMENTS: "0", LOW_BALANCE_WBT: "0.02" })).toMatchObject({
        maxGasLimit: 250_000n, maxGasPrice: 1_000_000_000n, maxReplacements: 0, lowBalanceWei: 2n * 10n ** 16n });
  });
  it.each([
    ["MAX_GAS_LIMIT", "0"], ["MAX_GAS_PRICE", "-1"], ["PAYER_CAP_USDT", "-1"],
    ["LOSS_BUDGET_WBT_PER_HOUR", "NaN"], ["LOW_BALANCE_WBT", "-0.01"],
    ["PAYER_CAP_USDT", "0.0000001"], ["MAX_REPLACEMENTS", "11"], ["PENDING_RETRY_SECONDS", "0"],
  ])("rejects invalid %s=%s", (key, value) => {
    expect(() => loadConfig({ ...env, [key]: value })).toThrow();
  });
});
