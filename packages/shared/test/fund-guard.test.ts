import { describe, expect, it } from "vitest";
import { QUALIFYING_USDT, checkFundPlan, FUND_CAP_BASE_UNITS } from "../src/index.js";

const payer = "0x30Ab1c2f5d1D8794FdFE60EFa412F80D03037478";
const ok = { chainId: 1874, token: QUALIFYING_USDT, to: payer, amountBase: 5_000_000n, payerWbt: 0n };

describe("fund-payer guard", () => {
  it("accepts a small official-USDT transfer to a payer with no WBT", () => {
    expect(() => checkFundPlan(ok)).not.toThrow();
  });
  it("refuses any chain but 1874", () => {
    expect(() => checkFundPlan({ ...ok, chainId: 1 })).toThrow(/chain/i);
  });
  it("refuses any token but the official USDT, however it is cased", () => {
    expect(() => checkFundPlan({ ...ok, token: "0x02Dd211C97b0611146ce9D673F9C56B4fbC9e6f4" })).toThrow(/token/i);
    expect(() => checkFundPlan({ ...ok, token: QUALIFYING_USDT.toLowerCase() })).not.toThrow();
  });
  it("refuses a native (WBT) transfer: this tool sends USDT only", () => {
    expect(() => checkFundPlan({ ...ok, token: "native" })).toThrow(/token/i);
  });
  it("refuses amounts above the per-call cap, zero and negative", () => {
    expect(() => checkFundPlan({ ...ok, amountBase: FUND_CAP_BASE_UNITS + 1n })).toThrow(/cap/i);
    expect(() => checkFundPlan({ ...ok, amountBase: FUND_CAP_BASE_UNITS })).not.toThrow();
    expect(() => checkFundPlan({ ...ok, amountBase: 0n })).toThrow(/amount/i);
    expect(() => checkFundPlan({ ...ok, amountBase: -1n })).toThrow(/amount/i);
  });
  it("refuses a payer that already holds any WBT (the demo needs a zero-gas payer)", () => {
    expect(() => checkFundPlan({ ...ok, payerWbt: 1n })).toThrow(/WBT/);
  });
  it("refuses a malformed or zero recipient", () => {
    expect(() => checkFundPlan({ ...ok, to: "0x123" })).toThrow(/recipient/i);
    expect(() => checkFundPlan({ ...ok, to: "0x0000000000000000000000000000000000000000" })).toThrow(/recipient/i);
  });
});
