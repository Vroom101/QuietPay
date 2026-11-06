// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { orderSettled } from "@quietpay/shared/fixtures";
import { RefundPanel } from "../src/RefundPanel";
import { refundState } from "./refund-fixtures";
let root: Root, container: HTMLDivElement;
const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
};
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name,
  )!;
async function enter(value: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount(fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher);
  await act(async () =>
    root.render(
      <RefundPanel
        order={orderSettled}
        options={{ merchantUrl: "/api/merchant", apiKey: "access" }}
        onChanged={() => undefined}
        onClose={() => undefined}
      />,
    ),
  );
  await flush();
}
it("shows the signer balance and disables a refund it cannot fund", async () => {
  await mount(vi.fn(async () => new Response(JSON.stringify(refundState()))));
  expect(container.textContent).toContain("6.000000 USDT");
  await enter("7");
  expect(button("Review refund").disabled).toBe(true);
  expect(container.textContent).toContain("balance is too low");
  await enter("5");
  expect(button("Review refund").disabled).toBe(false);
});
it("reviews the amount and posts only a business request, then shows pending progress", async () => {
  const state = refundState();
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      const request = {
        ...body,
        orderId: orderSettled.id,
        status: "pending",
        createdAt: 1,
        refund: {
          id: "0x" + "aa".repeat(32),
          orderId: orderSettled.id,
          amount: body.amount,
          refundIndex: body.refundIndex,
          status: "pending",
          createdAt: 1,
        },
      };
      state.requests.push(request);
      state.refunds.push(request.refund);
      return new Response(JSON.stringify(request), { status: 202 });
    }
    return new Response(JSON.stringify(state));
  });
  await mount(fetcher as typeof fetch);
  await enter("5.000001");
  await act(async () => button("Review refund").click());
  expect(container.textContent).toContain("Return 5.000001 USDT");
  await act(async () => button("Confirm refund").click());
  await flush();
  const post = fetcher.mock.calls.find((call) => call[1]?.method === "POST")!;
  const body = JSON.parse(post[1]!.body as string);
  expect(Object.keys(body).sort()).toEqual([
    "amount",
    "refundIndex",
    "requestId",
  ]);
  expect(body).toMatchObject({ amount: "5000001", refundIndex: 1 });
  expect(container.textContent).toContain("pending");
  expect(button("Review refund").disabled).toBe(true);
  expect(localStorage.length).toBe(1);
});
it("preserves the original request after an uncertain server failure", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(
          JSON.stringify({
            error: { message: "Refund status could not be confirmed." },
          }),
          { status: 502 },
        )
      : new Response(JSON.stringify(refundState())),
  );
  await mount(fetcher as typeof fetch);
  await enter("5");
  await act(async () => button("Review refund").click());
  await act(async () => button("Confirm refund").click());
  await flush();
  expect(localStorage.length).toBe(1);
  expect(button("Check original request")).toBeTruthy();
  expect(button("Review refund").disabled).toBe(true);
});

it("keeps a definitive rejection visible after refreshing status", async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(
          JSON.stringify({
            error: {
              code: "refund_index_changed",
              message:
                "Refund status changed. Refresh and review the remaining amount.",
            },
          }),
          { status: 409 },
        )
      : new Response(JSON.stringify(refundState())),
  );
  await mount(fetcher as typeof fetch);
  await enter("5");
  await act(async () => button("Review refund").click());
  await act(async () => button("Confirm refund").click());
  await flush();
  expect(container.textContent).toContain("Refund status changed");
  expect(localStorage.length).toBe(0);
  expect(button("Review refund").disabled).toBe(false);
});

it("recovers a saved request after reload and clears it only when settlement is confirmed", async () => {
  const state = refundState();
  const original = {
    requestId: "11111111-1111-4111-8111-111111111111",
    amount: "5000000",
    refundIndex: 1,
  };
  localStorage.setItem(
    `qp-refund:/api/merchant:${orderSettled.id}`,
    JSON.stringify(original),
  );
  state.requests.push({
    ...original,
    orderId: orderSettled.id,
    status: "unknown",
    createdAt: 1,
  });
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      expect(JSON.parse(init.body as string)).toEqual(original);
      const refund = {
        id: "0x" + "aa".repeat(32),
        orderId: orderSettled.id,
        amount: "5000000",
        refundIndex: 1,
        status: "settled" as const,
        createdAt: 1,
      };
      state.requests = [
        {
          ...original,
          orderId: orderSettled.id,
          status: "settled",
          refund,
          createdAt: 1,
        },
      ];
      state.refunds = [refund];
      state.context.refunded = "10000000";
      state.context.refundIndex = 2;
      return new Response(JSON.stringify(state.requests[0]));
    }
    return new Response(JSON.stringify(state));
  });
  await mount(fetcher as typeof fetch);
  expect(button("Review refund").disabled).toBe(true);
  await act(async () => button("Check original request").click());
  await flush();
  expect(container.textContent).toContain("Refund completed.");
  expect(container.textContent).toContain("15.000000 USDT");
  expect(localStorage.length).toBe(0);
  expect(
    fetcher.mock.calls.filter((call) => call[1]?.method === "POST"),
  ).toHaveLength(1);
});
