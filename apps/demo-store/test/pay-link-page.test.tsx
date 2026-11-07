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

const ORDER = "0x" + "cd".repeat(32);
const PAYOUT = "0x" + "11".repeat(20);
const LINK = { id: "link1", title: "Logo design", description: "Final files in SVG and PNG", amount: "12.500000", status: "active", expiresAt: null, merchantName: "Ava Studio" };
const CHECKOUT = { checkout: { orderId: ORDER, amount: "12.500000", payout: PAYOUT } };

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
let PayLinkPage: typeof import("../src/pages/PayLink.js").PayLinkPage;

beforeAll(async () => {
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ MemoryRouter, Routes, Route } = await import("react-router-dom"));
  ({ PayLinkPage } = await import("../src/pages/PayLink.js"));
});

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLElement;
let store: Record<string, string>;

beforeEach(() => {
  widgetCalls.length = 0;
  store = {};
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });
  routes = { "GET /api/links/link1": () => json(LINK) };
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
});

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function mount(path = "/pay/link1") {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/pay/:id" element={<PayLinkPage />} />
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

describe("Feature: payment link page", () => {
  it("Scenario: merchant, title, description and the big amount render", async () => {
    await mount();
    expect(text()).toContain("Ava Studio");
    expect(text()).toContain("Logo design");
    expect(text()).toContain("Final files in SVG and PNG");
    expect(container.querySelector(".gateway-card-amount")?.textContent).toBe("12.500000USDT");
    expect(button("Pay with stablecoin")).toBeTruthy();
    expect(container.querySelector("[data-testid=widget]")).toBeNull();
  });

  it("Scenario: loading, then the server's error for an unknown link", async () => {
    routes["GET /api/links/link1"] = () => json({ error: "Link not found." }, 404);
    await mount();
    expect(text()).toContain("Link not found.");
    expect(button("Pay with stablecoin")).toBeUndefined();
  });

  it("Scenario: paying posts the checkout, keeps the token and pins the widget to the server's amount and payout", async () => {
    let posted = 0;
    routes["POST /api/links/link1/checkout"] = () => { posted += 1; return json(CHECKOUT, 201, { [ORDER_TOKEN_HEADER]: "tok-abcdefghijklmnopqrstuvwxyz0123456789" }); };
    await mount();
    await click(button("Pay with stablecoin"));
    expect(posted).toBe(1);
    expect(tokenFor(ORDER)).toBe("tok-abcdefghijklmnopqrstuvwxyz0123456789");
    const widget = container.querySelector("[data-testid=widget]");
    expect(widget?.getAttribute("data-order")).toBe(ORDER);
    expect(widget?.getAttribute("data-amount")).toBe("12.500000");
    expect(widget?.getAttribute("data-payout")).toBe(PAYOUT);
    expect(button("Pay with stablecoin")).toBeUndefined();
  });

  it("Scenario: settling the widget lands on the receipt page for the order", async () => {
    routes["POST /api/links/link1/checkout"] = () => json(CHECKOUT, 201, { [ORDER_TOKEN_HEADER]: "tok-abcdefghijklmnopqrstuvwxyz0123456789" });
    await mount();
    await click(button("Pay with stablecoin"));
    await click(button("settle"));
    expect(text()).toContain("receipt page");
    expect(container.querySelector("[data-testid=widget]")).toBeNull();
  });

  it("Scenario: a 409 from checkout shows the message and no widget", async () => {
    routes["POST /api/links/link1/checkout"] = () => json({ error: "This link has already been paid." }, 409);
    await mount();
    await click(button("Pay with stablecoin"));
    expect(container.querySelector("[role=alert]")?.textContent).toBe("This link has already been paid.");
    expect(container.querySelector("[data-testid=widget]")).toBeNull();
    expect(button("Pay with stablecoin")).toBeTruthy();
  });

  it("Scenario: a malformed checkout answer is treated as a failure", async () => {
    routes["POST /api/links/link1/checkout"] = () => json({ checkout: { orderId: "nope", amount: "1", payout: PAYOUT } }, 201);
    await mount();
    await click(button("Pay with stablecoin"));
    expect(container.querySelector("[role=alert]")).toBeTruthy();
    expect(container.querySelector("[data-testid=widget]")).toBeNull();
  });

  for (const [status, message] of [
    ["paid", "This link has already been paid"],
    ["deactivated", "This link is no longer active"],
    ["expired", "This link has expired"],
  ] as const) {
    it(`Scenario: a ${status} link says "${message}" and offers no payment`, async () => {
      routes["GET /api/links/link1"] = () => json({ ...LINK, status });
      await mount();
      expect(container.querySelector("[role=status]")?.textContent).toBe(message);
      expect(text()).toContain("Logo design");
      expect(button("Pay with stablecoin")).toBeUndefined();
      expect(container.querySelector("[data-testid=widget]")).toBeNull();
    });
  }
});
