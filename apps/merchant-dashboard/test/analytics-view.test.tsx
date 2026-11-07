// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Analytics } from "../src/Analytics";
import type { DashboardOrder } from "../src/lib/view";

let root: Root, container: HTMLDivElement;
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 0, 20, 12) / 1000;
const W1 = "0x" + "11".repeat(20), W2 = "0x" + "22".repeat(20);
const o = (id: string, over: Partial<DashboardOrder> = {}): DashboardOrder => ({
  id, status: "settled", amount: "10000000", fee: "100000", createdAt: NOW - 3600, settledAt: NOW - 3590, payer: W1, ...over,
}) as DashboardOrder;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const render = async (el: React.ReactElement) => { await act(async () => root.render(el)); await flush(); };

it("shows an empty state with no orders", async () => {
  await render(<Analytics orders={[]} range="all" demo={false} merchantUrl="/m" now={NOW} />);
  expect(container.textContent).toContain("No orders in this period yet");
  expect(container.querySelector("svg")).toBeNull();
});

it("reads well with a single order", async () => {
  await render(<Analytics orders={[o("a")]} range="all" demo={false} merchantUrl="/m" now={NOW} />);
  const t = container.textContent!;
  expect(t).toContain("1 wallet paid so far and none has come back yet");
  expect(t).toContain("median of 10s");
  expect(t).toContain("No earlier period to compare with");
  expect(t).toContain("No refunds in this period");
  expect(container.querySelector('[data-testid="heatmap-summary"]')!.textContent).toContain("Busiest: Tue 11:00 UTC (1)");
  expect(container.querySelectorAll(".md-an-heat rect")).toHaveLength(7 * 24);
  expect(container.querySelector(".md-an-heat rect title")!.textContent).toMatch(/UTC: \d+ paid order/);
});

it("compares to the previous period, splits the mix and shows live sections", async () => {
  const day = 86400;
  const orders = [
    o("a", { payer: W1 }), o("b", { payer: W1, reference: "sub:s1:2" }), o("c", { payer: W2, amount: "30000000" }),
    o("p1", { createdAt: NOW - 10 * day, settledAt: NOW - 10 * day + 5 }),
    o("x", { status: "expired", settledAt: undefined }),
  ];
  const csv = ["date_utc,source,order_id,merchant_id,payer,gross_usdt,tx_hash", `2026-01-19 10:00:00,x402,,m,0x${"33".repeat(20)},5.00,`].join("\n");
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url.endsWith("/subscriptions") ? json({ subscriptions: [
      { id: "s1", status: "active", plan: { amountBase: "5000000", interval: "month", intervalCount: 1 }, customer: W1, createdAt: 1 },
      { id: "s2", status: "cancelled", plan: { amountBase: "5000000", interval: "month", intervalCount: 1 }, customer: W2, createdAt: 1 }] })
      : url.endsWith("/ledger/export") ? json({ csv, meta: {} }) : json({}, 404)));
  await render(<Analytics orders={orders} range="7" demo={false} merchantUrl="/m" token="t" now={NOW} />);
  const t = container.textContent!;
  expect(t).toContain("▲ 200.0%"); // 3 paid vs 1 in the previous 7 days
  expect(t).toContain("Repeat customers bring");
  expect(t).toContain("AI agents (x402)");
  expect(t).toContain("Subscription renewals");
  expect(t).toContain("Churned (cancelled)");
  expect(t).toContain("5.000000 USDT a month");
  expect(t).toContain("1 checkout expired unpaid");
  expect(t).not.toContain("gas tank");
});

it("demo mode hides live-only sections", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in demo"); }));
  await render(<Analytics orders={[o("a"), o("b", { payer: W2 })]} range="all" demo merchantUrl="/m" token="t" now={NOW} />);
  const t = container.textContent!;
  expect(t).toContain("Customers");
  expect(t).toContain("Checkout funnel");
  expect(t).not.toContain("Speed");
  expect(t).not.toContain("Unit economics");
  expect(t).not.toContain("Subscriptions");
  expect(t).not.toContain("AI agents (x402)");
  expect(fetch).not.toHaveBeenCalled();
});
