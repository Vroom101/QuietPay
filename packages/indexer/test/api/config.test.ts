import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/api/config.js";
import { address, MERCHANT } from "./helpers.js";
const env = {
  RPC_URL: "http://localhost:8545",
  ROUTER_ADDRESS: address(3),
  USDT_ADDRESS: address(4),
  INDEXER_FROM_BLOCK: "2",
};
describe("ledger configuration", () => {
  it("needs no gas wallet or merchant key for independent CLI verification", () => {
    expect(loadConfig(env)).toMatchObject({
      scope: { chainId: 1874, deploymentBlock: 2, confirmations: 2 },
      port: 8788,
    });
    expect(loadConfig(env).apiKeys.size).toBe(0);
  });
  it("parses merchant scope and optional agent transfer attribution", () => {
    const cfg = loadConfig({
      ...env,
      MERCHANT_API_KEYS: `key:${MERCHANT}`,
      FACILITATOR_PAYTO: address(5),
      FACILITATOR_MERCHANT_ID: MERCHANT,
    });
    expect(cfg.apiKeys.get("key")).toBe(MERCHANT);
    expect(cfg.scope.agent?.payTo).toBe(address(5));
  });
  it("rejects incomplete attribution, invalid ranges and malformed keys", () => {
    expect(() => loadConfig({ ...env, INDEXER_FROM_BLOCK: "" })).toThrow();
    expect(() => loadConfig({ ...env, FACILITATOR_PAYTO: address(5) })).toThrow(
      "both",
    );
    expect(() => loadConfig({ ...env, INDEXER_FROM_BLOCK: "-1" })).toThrow();
    expect(() => loadConfig({ ...env, MERCHANT_API_KEYS: "bad" })).toThrow(
      "Invalid",
    );
  });
});
