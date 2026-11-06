import { describe, expect, it } from "vitest";
import { buildMetrics, orderNet } from "../src/DashboardMetrics";
import type { DashboardOrder } from "../src/lib/view";

const CHECKOUT = { chainId: 1874, token: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" } as never;
let n = 0;
const order = (o: Partial<DashboardOrder> & Pick<DashboardOrder, "status" | "amount">): DashboardOrder => ({
  id: "0x" + (++n).toString(16).padStart(64, "0"), fee: "50000", createdAt: 1_800_000_000, settledAt: 1_800_000_010,
  refunded: "0", refundCount: 0, checkout: CHECKOUT, ...o,
}) as DashboardOrder;
const by = (orders: DashboardOrder[]) => Object.fromEntries(buildMetrics(orders, false).map((m) => [m.label, m]));

describe("Feature: merchant overview numbers tell the truth and explain themselves", () => {
  it("Scenario: a fully refunded order leaves the merchant out the relay fee, and the card says why", () => {
    const m = by([order({ status: "refunded", amount: "8500000", refunded: "8500000" })]);
    expect(orderNet(order({ status: "refunded", amount: "8500000", refunded: "8500000" }))).toBe(-50000n);
    expect(m["Net revenue"].value).toBe("−0.050000");
    expect(m["Net revenue"].detail).toMatch(/relay fee is not returned/i);
  });

  it("Scenario: a normal paid order shows positive net with the standard note", () => {
    const m = by([order({ status: "settled", amount: "8500000" })]);
    expect(m["Net revenue"].value).toBe("8.450000");
    expect(m["Net revenue"].detail).toBe("After relay fees and refunds");
  });

  it("Scenario: unpaid orders (open carts) never change revenue or the paid count", () => {
    const paid = order({ status: "settled", amount: "8500000" });
    const withCarts = by([paid, order({ status: "created", amount: "25000000" }), order({ status: "created", amount: "12000000" })]);
    const alone = by([paid]);
    expect(withCarts["Net revenue"].value).toBe(alone["Net revenue"].value);
    expect(withCarts["Successful payments"].value).toBe("1");
    expect(withCarts["Average order value"].value).toBe(alone["Average order value"].value);
  });

  it("Scenario: abandoned checkouts are called what they are, not 'payment failures'", () => {
    const m = by([
      order({ status: "settled", amount: "8500000" }),
      order({ status: "expired", amount: "25000000", settledAt: undefined }),
      order({ status: "created", amount: "12000000", settledAt: undefined }),
    ]);
    const rate = m["Checkout completion rate"];
    expect(rate).toBeDefined();
    expect(m["Payment success rate"]).toBeUndefined();
    expect(rate.value).toBe("50.0%"); // 1 paid of 2 finished checkouts (the open one is not decided yet)
    expect(rate.detail).toMatch(/1 still open/);
  });

  it("Scenario: no finished checkouts shows a dash, not 0% or NaN", () => {
    expect(by([order({ status: "created", amount: "1000000" })])["Checkout completion rate"].value).toBe("—");
  });

  it("Scenario: a failed payment still counts against completion", () => {
    const m = by([order({ status: "settled", amount: "8500000" }), order({ status: "failed", amount: "8500000", settledAt: undefined })]);
    expect(m["Checkout completion rate"].value).toBe("50.0%");
  });
});
