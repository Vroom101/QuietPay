import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { ORDER_TOKEN_HEADER } from "@quietpay/shared";
import { tokenFor } from "../src/order-token.js";

// The widget package carries jsdom; the test config stays on the node environment for the server tests.
const requireFromWidget = createRequire(fileURLToPath(new URL("../../../packages/widget/package.json", import.meta.url)));
const { JSDOM } = requireFromWidget("jsdom") as { JSDOM: new (html: string, options: { url: string }) => { window: Record<string, any> } };
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost/" });
const g = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "HTMLInputElement"]) {
  Object.defineProperty(g, key, { value: dom.window[key], configurable: true, writable: true });
}
g.IS_REACT_ACT_ENVIRONMENT = true;

// Stub widget: exposes the pinned values and a button that simulates settlement.
const widgetCalls: Array<Record<string, unknown>> = [];
vi.mock("@quietpay/widget/react", () => ({
  QuietpayCheckout: (props: Record<string, unknown> & { onSettled: () => void }) => {
    widgetCalls.push(props);
    return (
      <div data-testid="widget" data-order={String(props.orderId)} data-amount={String(props.expectedAmount)} data-payout={String(props.expectedPayout)}>
        <button onClick={props.onSettled}>settle</button>
      </div>
    );
  },
}));

const ORDER = "0x" + "ab".repeat(32);
const PAYOUT = "0x" + "11".repeat(20);
const PLAN = { id: "plan1", name: "Quiet Club", amount: "9.500000", amountBase: "9500000", interval: "month", intervalCount: 1 };
const sub = (over: Record<string, unknown> = {}) => ({
  id: "sub1", plan: PLAN, status: "active", paidPeriods: 1, nextCharge: "2030-01-15T00:00:00.000Z", due: false, ...over,
});
const CHECKOUT = { orderId: ORDER, amount: "9.500000", payout: PAYOUT };

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
let routes: Record<string, Handler>;
let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let MemoryRouter: typeof import("react-router-dom").MemoryRouter;
let Routes: typeof import("react-router-dom").Routes;
let Route: typeof import("react-router-dom").Route;
let SubscribePage: typeof import("../src/pages/Billing.js").SubscribePage;
let SubscriptionPage: typeof import("../src/pages/Billing.js").SubscriptionPage;

beforeAll(async () => {
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ MemoryRouter, Routes, Route } = await import("react-router-dom"));
  ({ SubscribePage, SubscriptionPage } = await import("../src/pages/Billing.js"));
});

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLElement;
let store: Record<string, string>;

beforeEach(() => {
  widgetCalls.length = 0;
  store = {};
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });
  routes = {};
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = routes[`${init?.method ?? "GET"} ${url}`];
    if (!handler) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function mount(path: string) {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/subscribe/:id" element={<SubscribePage />} />
          <Route path="/subscription/:id" element={<SubscriptionPage />} />
          <Route path="/success/:id" element={<p>receipt page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
}

const text = () => container.textContent ?? "";
const button = (label: string | RegExp) =>
  [...container.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? "")));
async function click(el: Element | undefined) {
  expect(el).toBeTruthy();
  await act(async () => { el!.dispatchEvent(new (dom.window.MouseEvent as typeof MouseEvent)("click", { bubbles: true })); });
  await flush();
}

describe("Feature: subscribe page", () => {
  beforeEach(() => { routes["GET /api/plans/plan1"] = () => json(PLAN); });

  it("Scenario: the plan, amount and interval render with no simulation wording", async () => {
    await mount("/subscribe/plan1");
    expect(text()).toContain("Quiet Club");
    expect(text()).toContain("9.500000 USDT every month");
    expect(text()).toContain("QUIETPAY · SUBSCRIPTION");
    expect(text().toLowerCase()).not.toContain("simulation");
    expect(text().toLowerCase()).not.toContain("demo");
    expect(text()).toContain("Each payment needs my signature; nothing is taken automatically.");
  });

  it("Scenario: multi-period plans read 'every 3 months'", async () => {
    routes["GET /api/plans/plan1"] = () => json({ ...PLAN, intervalCount: 3 });
    await mount("/subscribe/plan1");
    expect(text()).toContain("every 3 months");
  });

  it("Scenario: an unknown plan shows the server's error", async () => {
    routes["GET /api/plans/plan1"] = () => json({ error: "plan not found" }, 404);
    await mount("/subscribe/plan1");
    expect(text()).toContain("plan not found");
  });

  it("Scenario: consent is required before subscribing", async () => {
    await mount("/subscribe/plan1");
    const subscribeButton = button("Subscribe and pay first period") as HTMLButtonElement;
    expect(subscribeButton.disabled).toBe(true);
    await click(container.querySelector("input[type=checkbox]") ?? undefined);
    expect((button("Subscribe and pay first period") as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("Scenario: subscribing posts consent, stores the order token and mounts the widget for the order", async () => {
    let body: unknown;
    routes["POST /api/plans/plan1/subscribe"] = (init) => {
      body = JSON.parse(String(init?.body));
      return json({ subscription: sub({ paidPeriods: 0 }), checkout: CHECKOUT }, 201, { [ORDER_TOKEN_HEADER]: "tok-abcdefghijklmnopqrstuvwxyz0123456789" });
    };
    routes["GET /api/subscriptions/sub1"] = () => json(sub());
    await mount("/subscribe/plan1");
    await click(container.querySelector("input[type=checkbox]") ?? undefined);
    await click(button("Subscribe and pay first period"));

    expect(body).toEqual({ consent: true });
    expect(tokenFor(ORDER)).toBe("tok-abcdefghijklmnopqrstuvwxyz0123456789");
    const widget = container.querySelector("[data-testid=widget]");
    expect(widget?.getAttribute("data-order")).toBe(ORDER);
    expect(widget?.getAttribute("data-amount")).toBe("9.500000");
    expect(widget?.getAttribute("data-payout")).toBe(PAYOUT);

    // Settling the widget moves on to the subscription page.
    await click(button("settle"));
    expect(text()).toContain("Periods paid");
  });

  it("Scenario: right after paying the first period, the webhook lags: confirm, never offer 'Pay now' for it", async () => {
    routes["POST /api/plans/plan1/subscribe"] = () =>
      json({ subscription: sub({ paidPeriods: 0 }), checkout: CHECKOUT }, 201, { [ORDER_TOKEN_HEADER]: "tok-abcdefghijklmnopqrstuvwxyz0123456789" });
    let polls = 0;
    routes["GET /api/subscriptions/sub1"] = () => {
      polls += 1;
      return json(polls < 2 ? sub({ paidPeriods: 0, pendingOrderId: ORDER, due: true }) : sub({ paidPeriods: 1, lastPaidOrderId: ORDER }));
    };
    await mount("/subscribe/plan1");
    await click(container.querySelector("input[type=checkbox]") ?? undefined);
    await click(button("Subscribe and pay first period"));
    vi.useFakeTimers();
    await act(async () => { button("settle")!.dispatchEvent(new (dom.window.MouseEvent as typeof MouseEvent)("click", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(text()).toContain("Confirming your payment");
    expect(button(/Pay .* now/)).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(text()).toContain("Periods paid1");
    expect(text()).not.toContain("Confirming your payment");
    expect(button(/Pay .* now/)).toBeUndefined();
  });

  it("Scenario: a failed subscribe shows the error and keeps the form", async () => {
    routes["POST /api/plans/plan1/subscribe"] = () => json({ error: "plan is not available" }, 400);
    await mount("/subscribe/plan1");
    await click(container.querySelector("input[type=checkbox]") ?? undefined);
    await click(button("Subscribe and pay first period"));
    expect(text()).toContain("plan is not available");
    expect(container.querySelector("[data-testid=widget]")).toBeNull();
  });
});

describe("Feature: subscription page", () => {
  const load = (view: unknown) => { routes["GET /api/subscriptions/sub1"] = () => json(view); };

  it("Scenario: an active, paid-up subscription shows status, periods and receipt, with no pay button", async () => {
    load(sub({ lastPaidOrderId: ORDER }));
    await mount("/subscription/sub1");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Active");
    expect(text()).toContain("Quiet Club");
    expect(text()).toContain("Periods paid1");
    expect(text()).toContain("QUIETPAY · SUBSCRIPTION");
    expect(container.querySelector(`a[href="/success/${ORDER}"]`)).toBeTruthy();
    expect(button(/Pay .* now/)).toBeUndefined();
    expect(text().toLowerCase()).not.toContain("simulation");
  });

  it("Scenario: past_due shows 'Payment due' and a pay button", async () => {
    load(sub({ status: "past_due", due: true }));
    await mount("/subscription/sub1");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Payment due");
    expect(button("Pay 9.500000 USDT now")).toBeTruthy();
  });

  it("Scenario: a pending order also offers the pay button", async () => {
    load(sub({ pendingOrderId: ORDER }));
    await mount("/subscription/sub1");
    expect(button("Pay 9.500000 USDT now")).toBeTruthy();
  });

  it("Scenario: cancelled shows 'Cancelled' and neither pay nor cancel buttons", async () => {
    load(sub({ status: "cancelled", due: true, nextCharge: null }));
    await mount("/subscription/sub1");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Cancelled");
    expect(button(/Pay .* now/)).toBeUndefined();
    expect(button("Cancel subscription")).toBeUndefined();
  });

  it("Scenario: paying renews, stores the token, mounts the widget, then polls until the period is paid", async () => {
    load(sub({ status: "past_due", due: true }));
    routes["POST /api/subscriptions/sub1/renew"] = () =>
      json({ subscription: sub({ status: "past_due", due: true }), checkout: CHECKOUT }, 200, { [ORDER_TOKEN_HEADER]: "tok-renew-abcdefghijklmnopqrstuvwxyz012345" });
    await mount("/subscription/sub1");
    await click(button("Pay 9.500000 USDT now"));
    expect(tokenFor(ORDER)).toBe("tok-renew-abcdefghijklmnopqrstuvwxyz012345");
    expect(container.querySelector("[data-testid=widget]")?.getAttribute("data-order")).toBe(ORDER);

    vi.useFakeTimers();
    let polls = 0;
    routes["GET /api/subscriptions/sub1"] = () => {
      polls += 1;
      return json(polls < 2 ? sub({ status: "past_due", due: true }) : sub({ paidPeriods: 2, lastPaidOrderId: ORDER }));
    };
    await act(async () => { button("settle")!.dispatchEvent(new (dom.window.MouseEvent as typeof MouseEvent)("click", { bubbles: true })); });
    expect(text()).toContain("Confirming your payment");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(polls).toBe(1);
    expect(text()).toContain("Confirming your payment");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(polls).toBe(2);
    expect(text()).not.toContain("Confirming your payment");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Active");
    expect(text()).toContain("Periods paid2");
    expect(container.querySelector("[data-testid=widget]")).toBeNull();
  });

  it("Scenario: polling gives up after 30 seconds with a message", async () => {
    load(sub({ status: "past_due", due: true }));
    routes["POST /api/subscriptions/sub1/renew"] = () => json({ subscription: sub({ status: "past_due", due: true }), checkout: CHECKOUT });
    await mount("/subscription/sub1");
    await click(button("Pay 9.500000 USDT now"));
    vi.useFakeTimers();
    await act(async () => { button("settle")!.dispatchEvent(new (dom.window.MouseEvent as typeof MouseEvent)("click", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(32_000); });
    expect(text()).toContain("still being confirmed");
    expect(text()).not.toContain("Confirming your payment");
  });

  it("Scenario: a 409 from renew shows the server's message", async () => {
    load(sub({ due: true }));
    routes["POST /api/subscriptions/sub1/renew"] = () => json({ error: "subscription is not due yet" }, 409);
    await mount("/subscription/sub1");
    await click(button("Pay 9.500000 USDT now"));
    expect(container.querySelector("[role=alert]")?.textContent).toBe("subscription is not due yet");
    expect(container.querySelector("[data-testid=widget]")).toBeNull();
  });

  it("Scenario: cancelling asks first, posts to cancel, then shows Cancelled", async () => {
    load(sub());
    let cancelled = 0;
    routes["POST /api/subscriptions/sub1/cancel"] = () => { cancelled += 1; return json(sub({ status: "cancelled", nextCharge: null })); };
    await mount("/subscription/sub1");
    await click(button("Cancel subscription"));
    expect(cancelled).toBe(0);
    await click(button("Keep subscription"));
    expect(button("Cancel subscription")).toBeTruthy();
    await click(button("Cancel subscription"));
    await click(button("Confirm cancellation"));
    expect(cancelled).toBe(1);
    expect(container.querySelector("[role=status]")?.textContent).toBe("Cancelled");
    expect(button("Cancel subscription")).toBeUndefined();
  });

  it("Scenario: a cancel failure shows the error and keeps the subscription active", async () => {
    load(sub());
    routes["POST /api/subscriptions/sub1/cancel"] = () => json({ error: "try again" }, 500);
    await mount("/subscription/sub1");
    await click(button("Cancel subscription"));
    await click(button("Confirm cancellation"));
    expect(container.querySelector("[role=alert]")?.textContent).toBe("try again");
    expect(container.querySelector("[role=status]")?.textContent).toBe("Active");
  });
});
