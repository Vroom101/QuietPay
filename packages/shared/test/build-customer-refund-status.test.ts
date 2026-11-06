import { describe, expect, it } from "vitest";
import { CustomerRefundItem, CustomerRefundStatus, ORDER_TOKEN_HEADER } from "../src/index.js";

const id = `0x${"ab".repeat(32)}`;
const good = {
  orderId: id, status: "partially_refunded", amountPaid: "10000000", totalRefunded: "2500000", remaining: "7500000",
  currency: "USDT", lastUpdatedAt: 1_700_000_000,
  refunds: [{ amount: "2500000", status: "settled", txHash: id, createdAt: 1_700_000_000 }],
};

describe("customer refund status schemas", () => {
  it("exports the header name", () => expect(ORDER_TOKEN_HEADER).toBe("Quietpay-Order-Token"));
  it("accepts a well-formed status and a refund without txHash", () => {
    expect(CustomerRefundStatus.parse(good)).toEqual(good);
    expect(CustomerRefundItem.safeParse({ amount: "1", status: "pending", createdAt: 1 }).success).toBe(true);
  });
  it.each([
    ["extra top-level field", { ...good, merchantId: id }],
    ["status override", { ...good, status: "paid" }],
    ["wrong currency", { ...good, currency: "USDC" }],
    ["extra refund field", { ...good, refunds: [{ ...good.refunds[0], refundId: id }] }],
    ["refund failureCode", { ...good, refunds: [{ ...good.refunds[0], failureCode: "x" }] }],
    ["zero amountPaid", { ...good, amountPaid: "0" }],
  ])("rejects %s", (_n, v) => expect(CustomerRefundStatus.safeParse(v).success).toBe(false));
  it("item is strict", () => expect(CustomerRefundItem.safeParse({ amount: "1", status: "settled", createdAt: 1, refundIndex: 0 }).success).toBe(false));
});
