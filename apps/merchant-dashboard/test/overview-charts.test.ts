import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardMetrics } from "../src/DashboardMetrics";
import type { DashboardOrder } from "../src/lib/view";

const CHECKOUT = { chainId: 1874, token: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" } as never;
const order = (n: number, status: DashboardOrder["status"]): DashboardOrder => ({
  id: "0x" + n.toString(16).padStart(64, "0"), status, amount: "1000000", fee: "50000", refunded: "0", refundCount: 0,
  createdAt: 1_800_000_000 + n, settledAt: 1_800_000_010 + n, checkout: CHECKOUT,
}) as DashboardOrder;

describe("Overview charts", () => {
  const orders = [order(1, "settled"), order(2, "settled"), order(3, "expired")];
  it("shows the revenue chart and the payment status breakdown side by side", () => {
    const html = renderToStaticMarkup(createElement(DashboardMetrics, { orders, demo: false }));
    expect(html).toContain("Revenue over time");
    expect(html).toContain("Payment status breakdown");
    expect(html).toMatch(/class="md-charts"/);
  });
  it("charts='none' (Analytics) renders neither, so Analytics keeps its own breakdown only", () => {
    const html = renderToStaticMarkup(createElement(DashboardMetrics, { orders, demo: false, charts: "none" }));
    expect(html).not.toContain("Payment status breakdown");
    expect(html).not.toContain("Revenue over time");
  });
});
