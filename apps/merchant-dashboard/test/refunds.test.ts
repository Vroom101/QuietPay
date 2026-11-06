import { describe, it, expect } from "vitest";
import { orderSettled } from "@quietpay/shared/fixtures";
import { refundState } from "./refund-fixtures";
import { decimalAmount, preciseUsdt, refundProblem } from "../src/lib/refunds";
describe("refund amount guards", () => {
  it("uses exact six-decimal base units", () => {
    expect(decimalAmount("0.000001")).toBe(1n);
    expect(decimalAmount("5.000001")).toBe(5000001n);
    expect(preciseUsdt("5000001")).toBe("5.000001");
  });
  it.each(["0", "-1", "1e2", "1.0000001", "abc", "", ".1", "1."])(
    "rejects invalid input %s",
    (value) => {
      expect(decimalAmount(value)).toBeUndefined();
    },
  );
  it("blocks an unfunded amount and one above the remaining payment", () => {
    const state = refundState();
    expect(refundProblem(state, "5")).toBeUndefined();
    expect(refundProblem(state, "7")).toContain("too low");
    expect(refundProblem(state, "21")).toContain("exceeds");
    state.context.refunded = "25000000";
    expect(refundProblem(state, "1")).toContain("fully refunded");
  });
  it("blocks a second refund while settlement or submission is uncertain", () => {
    const state = refundState();
    state.requests.push({
      requestId: "11111111-1111-4111-8111-111111111111",
      orderId: orderSettled.id,
      amount: "1000000",
      refundIndex: 1,
      status: "unknown",
      createdAt: 1,
    });
    expect(refundProblem(state, "1")).toContain("being processed");
  });
});
