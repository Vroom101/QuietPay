// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubscriptionsPanel } from "../src/SubscriptionsPanel";
import { AgentPayments } from "../src/AgentPayments";
import { createPlan, listPlans, listSubscriptions, monthlyBase, summarize, SubscriptionsError, type PlanView } from "../src/lib/subscriptions";

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

const plan = (amountBase: string, interval: PlanView["interval"], intervalCount = 1): PlanView => ({ id: "p1", name: "Pro", amount: "x", amountBase, interval, intervalCount });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("normalizes recurring revenue to a month in bigint", () => {
  expect(monthlyBase(plan("12000000", "month"))).toBe(12000000n);
  expect(monthlyBase(plan("12000000", "year"))).toBe(1000000n);
  expect(monthlyBase(plan("1000000", "day"))).toBe(30000000n);
  expect(monthlyBase(plan("12000000", "week"))).toBe(52000000n);
  expect(monthlyBase(plan("12000000", "month", 3))).toBe(4000000n);
});
it("summarizes only active subscriptions", () => {
  const s = summarize([
    { status: "active", plan: plan("5000000", "month") },
    { status: "past_due", plan: plan("5000000", "month") },
    { status: "cancelled", plan: plan("5000000", "month") },
    { status: "active", plan: plan("24000000", "year") },
  ]);
  expect(s).toEqual({ active: 2, mrrBase: 7000000n });
});

it("client maps 401, 503 and network errors", async () => {
  const opts = (f: typeof fetch) => ({ merchantUrl: "/api/merchant", token: "t", fetch: f });
  await expect(listPlans(opts(vi.fn(async () => json({ error: "no" }, 401))))).rejects.toThrow(/session expired/);
  await expect(listSubscriptions(opts(vi.fn(async () => json({ error: "Subscriptions are turned off." }, 503))))).rejects.toThrow("Subscriptions are turned off.");
  await expect(listPlans(opts(vi.fn(async () => { throw new Error("x"); })))).rejects.toThrow(/not reachable/);
  await expect(listPlans({ merchantUrl: "/m", token: "" })).rejects.toBeInstanceOf(SubscriptionsError);
  await expect(listPlans(opts(vi.fn(async () => json({}))))).rejects.toThrow(/malformed/);
});
it("createPlan posts JSON with bearer auth", async () => {
  const f = vi.fn(async (_u: unknown, _i?: RequestInit) => json(plan("5000000", "month"), 201));
  await createPlan({ merchantUrl: "/api/merchant/", token: "tok", fetch: f as unknown as typeof fetch }, { name: "Pro", amount: "5.00", interval: "month" });
  const [url, init] = f.mock.calls[0]!;
  expect(url).toBe("/api/merchant/plans");
  expect(init!.method).toBe("POST");
  expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  expect(JSON.parse(init!.body as string)).toEqual({ name: "Pro", amount: "5.00", interval: "month" });
});

const sub = (over: object) => ({
  id: "s1", plan: { ...plan("5000000", "month"), name: "Pro", amount: "5.00" }, status: "active", paidPeriods: 2,
  nextCharge: "2026-02-01T00:00:00Z", due: false, lastPaidOrderId: "ord_9", customer: "0x" + "22".repeat(20), createdAt: 1, ...over,
});

it("renders plans, subscribers, status labels and summary", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url.endsWith("/plans") ? json({ plans: [{ ...plan("5000000", "month"), name: "Pro", amount: "5.00" }] })
      : json({ subscriptions: [sub({}), sub({ id: "s2", status: "past_due", due: true }), sub({ id: "s3", status: "cancelled" })] })));
  await act(async () => root.render(<SubscriptionsPanel merchantUrl="/api/merchant" token="t" />));
  await flush();
  const text = container.textContent!;
  expect(text).toContain("nothing is pulled automatically");
  expect(container.querySelector('[data-testid="subs-active"]')!.textContent).toBe("1");
  expect(container.querySelector('[data-testid="subs-mrr"]')!.textContent).toBe("5.000000 USDT");
  expect(text).toContain("Payment due");
  expect(text).toContain("Cancelled");
  expect(text).toContain("ord_9");
  expect((container.querySelector('input[aria-label="Signup link"]') as HTMLInputElement).value).toMatch(/\/subscribe\/p1$/);
});

it("shows the 503 message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Subscriptions are turned off for this store." }, 503)));
  await act(async () => root.render(<SubscriptionsPanel merchantUrl="/api/merchant" token="t" />));
  await flush();
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("Subscriptions are turned off for this store.");
});

it("validates the form, then creates a plan", async () => {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return json({ ...plan("5000000", "week", 2), id: "newp", name: "Weekly", amount: "5.00" }, 201);
    return url.endsWith("/plans") ? json({ plans: [] }) : json({ subscriptions: [] });
  });
  vi.stubGlobal("fetch", f);
  await act(async () => root.render(<SubscriptionsPanel merchantUrl="/api/merchant" token="t" />));
  await flush();
  const set = async (sel: string, v: string, proto: object = HTMLInputElement.prototype) => act(async () => {
    const el = container.querySelector(sel)!;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
  const submit = async () => { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await flush(); };
  await submit();
  expect(container.textContent).toContain("Give the plan a name.");
  await set('input[name="name"]', "Weekly");
  await set('input[name="amount"]', "5.00");
  await set('select[name="interval"]', "week", HTMLSelectElement.prototype);
  await set('input[name="count"]', "2");
  await submit();
  const post = f.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
  expect(JSON.parse(post[1]!.body as string)).toEqual({ name: "Weekly", amount: "5.00", interval: "week", intervalCount: 2 });
  expect(container.textContent).toContain("Weekly · 5.00 USDT every 2 weeks");
});

it("agent payments panel loads x402 rows, totals and links", async () => {
  const TX = "0x" + "cd".repeat(32);
  const csv = ["date_utc,source,order_id,merchant_id,payer,gross_usdt,relay_fee_usdt,refunded_usdt,net_usdt,status,tx_hash,block,log_index",
    `2026-01-01 10:00:00,x402,,m,0x${"33".repeat(20)},0.25,0,0,0.25,settled,${TX},1,0`,
    `2026-01-01 11:00:00,x402,,m,0x${"44".repeat(20)},0.75,0,0,0.75,settled,${TX},2,0`,
    `2026-01-01 12:00:00,order,o1,m,0x${"55".repeat(20)},9,0,0,9,settled,${TX},3,0`].join("\n");
  vi.stubGlobal("fetch", vi.fn(async () => json({ csv, meta: {} })));
  await act(async () => root.render(<AgentPayments merchantUrl="/api/merchant" token="t" />));
  await flush();
  expect(container.querySelector('[data-testid="agent-count"]')!.textContent).toBe("2");
  expect(container.querySelector('[data-testid="agent-total"]')!.textContent).toBe("1.000000 USDT");
  expect(container.querySelector("a")!.getAttribute("href")).toBe(`https://explorer.testnet.whitechain.io/tx/${TX}`);
  expect(container.textContent).toContain("QuietPay's facilitator pays the gas");
});

it("agent payments panel shows an error when the export fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "boom" } }, 500)));
  await act(async () => root.render(<AgentPayments merchantUrl="/api/merchant" token="t" />));
  await flush();
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("boom");
});
