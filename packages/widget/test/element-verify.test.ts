// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_ROUTER, makeOrder } from "@quietpay/shared/fixtures";
import type { Order } from "@quietpay/shared";
import "../src/element.js";
import type { QuietpayCheckout } from "../src/element.js";
import { CHECKOUT_MISMATCH_MESSAGE, WALLET_UNREADABLE_MESSAGE } from "../src/messages.js";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const RELAYER = "http://relayer.test";
const ORDER_ID = ("0x" + "ab".repeat(32)) as `0x${string}`;
const FORBIDDEN = /\b(gas|wbt|transactions?)\b/i;

/** Serves `order` for GET /v1/orders/:id and records every URL; relay/pay answers pending. */
function stubRelayer(order: Order) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("/v1/relay/pay")) {
      return new Response(JSON.stringify({ orderId: order.id, status: "pending" }), { status: 200 });
    }
    return new Response(JSON.stringify(order), { status: 200, headers: { "content-type": "application/json" } });
  });
  return calls;
}

function mount(attrs: Record<string, string> = {}) {
  const el = document.createElement("quietpay-checkout") as QuietpayCheckout;
  el.setAttribute("order-id", ORDER_ID);
  el.setAttribute("relayer-url", RELAYER);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

async function until(cond: () => boolean, ms = 5_000) {
  await vi.waitFor(() => expect(cond()).toBe(true), { timeout: ms, interval: 20 });
}

async function payAndExpectRefusal(el: QuietpayCheckout, calls: string[], code: string) {
  await until(() => el.view === "ready" && !!el.account);
  const spy = vi.spyOn(el.account!, "signTypedData");
  const errors: { code: string; message: string }[] = [];
  el.addEventListener("quietpay:error", (e) => errors.push((e as CustomEvent).detail));
  el.shadowRoot!.querySelector("button")!.click();
  await until(() => el.view === "error");
  await el.updateComplete;
  expect(el.errorCode).toBe(code);
  const alert = el.shadowRoot!.querySelector("[role=alert]")!;
  expect(alert.textContent).toBe(CHECKOUT_MISMATCH_MESSAGE);
  expect(alert.textContent).not.toMatch(FORBIDDEN);
  expect(errors[0]).toMatchObject({ code, message: CHECKOUT_MISMATCH_MESSAGE });
  expect(spy).not.toHaveBeenCalled();
  expect(calls.some((c) => c.endsWith("/v1/relay/pay"))).toBe(false);
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("<quietpay-checkout> verifies the checkout before signing", () => {
  it("refuses the mock router when no router override is set (default = deployed router)", async () => {
    const calls = stubRelayer(makeOrder({ id: ORDER_ID }));
    await payAndExpectRefusal(mount(), calls, "checkout_router_mismatch");
  });

  it("refuses an attacker router even when the router attribute is set", async () => {
    const o = makeOrder({ id: ORDER_ID });
    o.checkout.router = "0x000000000000000000000000000000000000dEaD";
    const calls = stubRelayer(o);
    await payAndExpectRefusal(mount({ router: FIXTURE_ROUTER }), calls, "checkout_router_mismatch");
  });

  it("refuses a wrong chain", async () => {
    const o = makeOrder({ id: ORDER_ID });
    o.checkout.chainId = 1;
    const calls = stubRelayer(o);
    await payAndExpectRefusal(mount({ router: FIXTURE_ROUTER }), calls, "checkout_chain_mismatch");
  });

  it("refuses when the order amount differs from expected-amount", async () => {
    const calls = stubRelayer(makeOrder({ id: ORDER_ID, amount: "26000000" }));
    await payAndExpectRefusal(mount({ router: FIXTURE_ROUTER, "expected-amount": "25" }), calls, "checkout_amount_mismatch");
  });

  it("refuses when expected-amount is not a valid decimal", async () => {
    const calls = stubRelayer(makeOrder({ id: ORDER_ID }));
    await payAndExpectRefusal(mount({ router: FIXTURE_ROUTER, "expected-amount": "25.0000001" }), calls, "checkout_config_invalid");
  });

  it("refuses when the relayer returns a different order than requested", async () => {
    const calls = stubRelayer(makeOrder({ id: ("0x" + "cd".repeat(32)) as `0x${string}` }));
    await payAndExpectRefusal(mount({ router: FIXTURE_ROUTER }), calls, "checkout_order_mismatch");
  });

  it("signs and relays when everything matches (router + expected-amount + chain-id + token properties)", async () => {
    const calls = stubRelayer(makeOrder({ id: ORDER_ID }));
    const el = mount({ router: FIXTURE_ROUTER, "expected-amount": "25", "chain-id": "1874" });
    await until(() => el.view === "ready" && !!el.account);
    const spy = vi.spyOn(el.account!, "signTypedData");
    el.shadowRoot!.querySelector("button")!.click();
    await until(() => calls.some((c) => c.endsWith("/v1/relay/pay")));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("<quietpay-checkout> with an unreadable stored wallet", () => {
  it("shows the wallet-unreadable message and never replaces the stored record", async () => {
    const open = (): Promise<IDBDatabase> =>
      new Promise((res, rej) => {
        const r = indexedDB.open("quietpay-wallet", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("keys");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const db = await open();
    await new Promise<void>((res) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put("corrupt", "default");
      tx.oncomplete = () => res();
    });
    db.close();

    stubRelayer(makeOrder({ id: ORDER_ID }));
    const el = mount({ router: FIXTURE_ROUTER });
    await until(() => el.view === "error");
    await el.updateComplete;
    expect(el.errorCode).toBe("wallet_unreadable");
    const alert = el.shadowRoot!.querySelector("[role=alert]")!;
    expect(alert.textContent).toBe(WALLET_UNREADABLE_MESSAGE);
    expect(alert.textContent).not.toMatch(FORBIDDEN);

    const db2 = await open();
    const stored = await new Promise((res) => {
      const r = db2.transaction("keys").objectStore("keys").get("default");
      r.onsuccess = () => res(r.result);
    });
    db2.close();
    expect(stored).toBe("corrupt");
  });
});
