import { describe, expect, it } from "vitest";
import { buildLedgerRows, type RawEvent } from "@quietpay/indexer";
import { deriveRows, type SpecEvent } from "../src/spec.js";
import { PAYER, PAYOUT, PAYTO, RELAYER, REFUND_SIGNER, ROUTER, USDT, MERCHANT, order, tx } from "./fake.js";

const OTHER = "0x9999999999999999999999999999999999999999";
let n = 0;
const ev = (kind: RawEvent["kind"], txHash: string, block: number, args: Record<string, string>, address = ROUTER): RawEvent => ({
  txHash, logIndex: n++, block, blockHash: tx(block), timestamp: 1_800_000_000 + block, address, kind, args,
});
const tr = (txHash: string, block: number, from: string, to: string, value: string) => ev("Transfer", txHash, block, { from, to, value }, USDT);
const paid = (txHash: string, block: number, payout = PAYOUT) =>
  ev("Paid", txHash, block, { merchantId: MERCHANT, orderId: order(1), payer: PAYER, payout, value: "10", fee: "1", relayer: RELAYER });
const refunded = (txHash: string, block: number) =>
  ev("Refunded", txHash, block, { merchantId: MERCHANT, orderId: order(1), payer: PAYER, amount: "3", totalRefunded: "3", refundIndex: "0" });

/** Runs both builders and requires identical rows; returns them. */
function both(events: RawEvent[], payTo = PAYTO) {
  const a = buildLedgerRows(events, { router: ROUTER, facilitatorPayTo: payTo, decimals: 6 });
  const b = deriveRows(events as unknown as SpecEvent[], { router: ROUTER, payTo, decimals: 6 });
  expect(b.map((r) => [r.source, r.gross, r.txHash, r.logIndex])).toEqual(a.map((r) => [r.source, r.grossUsdt, r.txHash, r.logIndex]));
  return a;
}
const deposits = (rows: ReturnType<typeof both>) => rows.filter((r) => r.source === "payto_transfer");

describe("T1d: narrowest double-count rule (from != router)", () => {
  it("counts a direct deposit batched with a pay in the same tx", () => {
    const T = tx(1);
    const rows = both([tr(T, 10, PAYER, ROUTER, "10"), tr(T, 10, ROUTER, PAYOUT, "9"), tr(T, 10, ROUTER, RELAYER, "1"), tr(T, 10, OTHER, PAYTO, "5000000"), paid(T, 10)]);
    expect(rows.filter((r) => r.source === "router")).toHaveLength(1);
    expect(deposits(rows).map((r) => r.grossUsdt)).toEqual(["5.000000"]);
  });
  it("counts a direct deposit batched with a refund in the same tx", () => {
    const P = tx(1), R = tx(2);
    const rows = both([paid(P, 10), tr(R, 20, REFUND_SIGNER, ROUTER, "3"), tr(R, 20, ROUTER, PAYER, "3"), tr(R, 20, OTHER, PAYTO, "2000000"), refunded(R, 20)]);
    expect(deposits(rows).map((r) => r.grossUsdt)).toEqual(["2.000000"]);
  });
  it("a router payout to the pay-to address is still counted once, as router", () => {
    const T = tx(1);
    const rows = both([tr(T, 10, PAYER, ROUTER, "10"), tr(T, 10, ROUTER, PAYTO, "9"), tr(T, 10, ROUTER, RELAYER, "1"), paid(T, 10, PAYTO)]);
    expect(deposits(rows)).toHaveLength(0);
    expect(rows.filter((r) => r.source === "router")).toHaveLength(1);
  });
  it("a refund paid back to a payer who is the pay-to address is not a deposit", () => {
    const R = tx(2);
    const rows = both([paid(tx(1), 10), tr(R, 20, REFUND_SIGNER, ROUTER, "3"), tr(R, 20, ROUTER, PAYTO, "3"), refunded(R, 20)]);
    expect(deposits(rows)).toHaveLength(0);
  });
  it("a plain deposit with no router log is counted", () => {
    expect(deposits(both([tr(tx(7), 30, OTHER, PAYTO, "1000000")]))).toHaveLength(1);
  });
  it("refuses a pay-to address equal to the router (every pull would look like a deposit)", () => {
    expect(() => buildLedgerRows([], { router: ROUTER, facilitatorPayTo: ROUTER, decimals: 6 })).toThrow();
    expect(() => deriveRows([], { router: ROUTER, payTo: ROUTER, decimals: 6 })).toThrow();
  });
});
