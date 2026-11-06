// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ERROR_CODES, ERROR_USER_MESSAGES, formatUsdt, recoverCheckoutSigner, type Order } from "@quietpay/shared";
import { createMockRelayer } from "@quietpay/shared/mock-server";
import { FIXTURE_ORDER_ID, FIXTURE_ROUTER } from "@quietpay/shared/fixtures";
import "../src/element.js";
import type { QuietpayCheckout } from "../src/element.js";

// jsdom does not ship SubtleCrypto; use Node's WebCrypto.
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

let server: Server;
let base: string;

beforeAll(async () => {
  server = createMockRelayer({ settleAfterMs: 300 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function createOrder(amount: string): Promise<Order> {
  const res = await fetch(`${base}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ merchantId: "0x" + "11".repeat(32), amount }),
  });
  return (await res.json()) as Order;
}

function mount(orderId: string, relayerUrl = base) {
  const el = document.createElement("quietpay-checkout") as QuietpayCheckout;
  el.setAttribute("order-id", orderId);
  el.setAttribute("relayer-url", relayerUrl);
  // The mock relayer serves the official chain/token/domain but a placeholder router; tell the widget to expect it.
  el.setAttribute("router", FIXTURE_ROUTER);
  document.body.appendChild(el);
  return el;
}

const text = (el: HTMLElement) => el.shadowRoot?.textContent ?? "";

async function until(cond: () => boolean, ms = 10_000) {
  await vi.waitFor(() => expect(cond()).toBe(true), { timeout: ms, interval: 25 });
}

const FORBIDDEN = /\b(gas|wbt|transactions?)\b/i;

describe("quietpay-checkout against the mock relayer", () => {
  it("runs the full flow: amount, pay, poll, receipt", async () => {
    const order = await createOrder("25000000");
    const el = mount(order.id);
    el.setAttribute("expected-amount", "25");
    await until(() => !!el.shadowRoot?.querySelector("button"));
    expect(text(el)).toContain(`${formatUsdt("25000000")} USDT`);
    const payer = el.shadowRoot!.querySelector("[data-testid=payer]")!.textContent!;
    expect(payer).toMatch(/^0x[0-9a-fA-F]{40}$/);

    el.shadowRoot!.querySelector("button")!.click();
    const settled = new Promise<Order>((res) => el.addEventListener("quietpay:settled", (e) => res((e as CustomEvent).detail.order)));
    await until(() => !!el.shadowRoot?.querySelector("[data-testid=receipt]"), 15_000);
    const o = await settled;
    expect(o.status).toBe("settled");
    expect(o.payer?.toLowerCase()).toBe(payer.toLowerCase());
    expect(el.shadowRoot!.querySelector("a")!.getAttribute("href")).toContain("https://");
    expect(text(el)).toContain("Payment complete");
    expect(text(el)).not.toMatch(FORBIDDEN);
    el.remove();
  }, 20_000);

  it("the signature posted to the relayer recovers the payer", async () => {
    const order = await createOrder("7000000");
    const posted: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).endsWith("/v1/relay/pay")) posted.push(JSON.parse(init.body));
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const el = mount(order.id);
      await until(() => !!el.shadowRoot?.querySelector("button"));
      el.shadowRoot!.querySelector("button")!.click();
      await until(() => posted.length === 1);
      const p = posted[0];
      const c = order.checkout;
      const signer = await recoverCheckoutSigner(
        {
          from: p.payer,
          router: c.router as `0x${string}`,
          value: BigInt(c.value),
          nonce: c.nonce as `0x${string}`,
          validAfter: BigInt(p.validAfter),
          validBefore: BigInt(p.validBefore),
          chainId: c.chainId,
          token: c.token as `0x${string}`,
          domainName: c.domain.name,
          domainVersion: c.domain.version,
        },
        p.signature,
      );
      expect(signer.toLowerCase()).toBe(p.payer.toLowerCase());
      expect(p.validBefore - p.validAfter).toBe(305);
      await until(() => !!el.shadowRoot?.querySelector("[data-testid=receipt]"), 15_000);
      el.remove();
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 25_000);

  it("shows an already-settled order as paid without a Pay button", async () => {
    const el = mount(FIXTURE_ORDER_ID);
    await until(() => text(el).includes("Payment complete"));
    expect(el.shadowRoot!.querySelector("button")).toBeNull();
    el.remove();
  });

  it("maps relayer failures at pay time to plain words (simulation_failed)", async () => {
    const order = await createOrder("5000001");
    const el = mount(order.id);
    await until(() => !!el.shadowRoot?.querySelector("button"));
    el.shadowRoot!.querySelector("button")!.click();
    await until(() => !!el.shadowRoot?.querySelector("[role=alert]"));
    expect(text(el)).toContain(ERROR_USER_MESSAGES.simulation_failed);
    el.remove();
  });

  it("maps rate_limited at pay time", async () => {
    const order = await createOrder("5000002");
    const el = mount(order.id);
    await until(() => !!el.shadowRoot?.querySelector("button"));
    el.shadowRoot!.querySelector("button")!.click();
    await until(() => !!el.shadowRoot?.querySelector("[role=alert]"));
    expect(text(el)).toContain(ERROR_USER_MESSAGES.rate_limited);
    el.remove();
  });

  it("order_not_found for an unknown order", async () => {
    const el = mount("0x" + "99".repeat(32));
    await until(() => !!el.shadowRoot?.querySelector("[role=alert]"));
    expect(text(el)).toContain(ERROR_USER_MESSAGES.order_not_found);
    el.remove();
  });

  it("tells the user in plain words when the service is unreachable", async () => {
    const el = mount(FIXTURE_ORDER_ID, "http://127.0.0.1:1");
    await until(() => !!el.shadowRoot?.querySelector("[role=alert]"));
    expect(text(el)).toContain("could not reach");
    expect(text(el)).not.toMatch(FORBIDDEN);
    el.remove();
  });

  it("includes the demo-grade note in the footer", async () => {
    const el = mount(FIXTURE_ORDER_ID);
    await until(() => text(el).includes("Demo wallet"));
    el.remove();
  });
});

describe("every relayer error code renders a message", () => {
  it.each(ERROR_CODES)("%s", async (code) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code, message: "raw server text" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const el = mount("0x" + "aa".repeat(32), "http://relayer.invalid");
      await until(() => !!el.shadowRoot?.querySelector("[role=alert]"));
      const alert = el.shadowRoot!.querySelector("[role=alert]")!;
      expect(alert.textContent).toBe(ERROR_USER_MESSAGES[code]);
      expect(alert.textContent).not.toMatch(FORBIDDEN);
      el.remove();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("failed orders map failureCode to its message", async () => {
    const realFetch = globalThis.fetch;
    const { orderFailed } = await import("@quietpay/shared/fixtures");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(orderFailed), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const el = mount(orderFailed.id, "http://relayer.invalid");
      await until(() => !!el.shadowRoot?.querySelector("[role=alert]"));
      expect(text(el)).toContain(ERROR_USER_MESSAGES.simulation_failed);
      el.remove();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
