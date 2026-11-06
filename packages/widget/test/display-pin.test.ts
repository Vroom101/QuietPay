// @vitest-environment jsdom
/**
 * The element pins the order it displays and refuses to sign a fresh order whose identity differs from it.
 * Each swapped order below is self-consistent (amount == value, nonce recomputed), so verifyCheckout alone would
 * accept it; only the display pin stops it.
 */
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { FIXTURE_ROUTER, makeOrder } from "@quietpay/shared/fixtures";
import { computePayNonce, merchantIdFromSlug, type Order } from "@quietpay/shared";
import "../src/element.js";
import type { QuietpayCheckout } from "../src/element.js";
import { WidgetError, pinDisplayedOrder, signCheckout, verifyDisplayedOrder } from "../src/client.js";
import { CHECKOUT_MISMATCH_MESSAGE } from "../src/messages.js";

Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const RELAYER = "http://relayer.test";
const ORDER_ID = ("0x" + "ab".repeat(32)) as Hex;
const OTHER_ROUTER = "0x5555555555555555555555555555555555555555" as Hex;
const OTHER_TOKEN = "0x6666666666666666666666666666666666666666" as Hex;
const OTHER_PAYOUT = "0x000000000000000000000000000000000000bEEF" as Hex;

/** Recomputes the nonce so the order stays self-consistent after a field was changed. */
function reNonce(o: Order): Order {
  o.checkout.nonce = computePayNonce({
    merchantId: o.merchantId as Hex,
    orderId: o.id as Hex,
    payout: o.checkout.payout as Hex,
    value: BigInt(o.checkout.value),
    fee: BigInt(o.checkout.fee),
  });
  return o;
}

const shown = () => makeOrder({ id: ORDER_ID });

/** Field name -> a self-consistent order that differs from shown() only in that field (plus a matching nonce). */
const SWAPS: Record<string, () => Order> = {
  amount: () => makeOrder({ id: ORDER_ID, amount: "100000000" }),
  fee: () => makeOrder({ id: ORDER_ID, fee: "90000" }),
  merchant: () => reNonce({ ...shown(), merchantId: merchantIdFromSlug("attacker-shop") }),
  payout: () => {
    const o = shown();
    o.payout = OTHER_PAYOUT;
    o.checkout.payout = OTHER_PAYOUT;
    return reNonce(o);
  },
  nonce: () => {
    const o = shown();
    o.checkout.nonce = ("0x" + "77".repeat(32)) as Hex;
    return o;
  },
  token: () => {
    const o = shown();
    o.checkout.token = OTHER_TOKEN;
    return o;
  },
  router: () => {
    const o = shown();
    o.checkout.router = OTHER_ROUTER;
    return o;
  },
  chain: () => {
    const o = shown();
    o.checkout.chainId = 31337;
    return o;
  },
  domain: () => {
    const o = shown();
    o.checkout.domain = { name: "Tether USD (fake)", version: o.checkout.domain.version };
    return o;
  },
};

/** Serves `first` for the first GET of the order and `later` for every later GET; records every URL. */
function swappingRelayer(first: Order, later: Order) {
  const calls: string[] = [];
  let gets = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("/v1/relay/pay")) {
      return new Response(JSON.stringify({ orderId: first.id, status: "pending" }), { status: 200 });
    }
    gets += 1;
    return new Response(JSON.stringify(gets === 1 ? first : later), { status: 200, headers: { "content-type": "application/json" } });
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

async function payAndExpectDisplayRefusal(el: QuietpayCheckout, calls: string[]) {
  await until(() => el.view === "ready" && !!el.account);
  await el.updateComplete;
  const shownText = el.shadowRoot!.querySelector(".amount")!.textContent;
  const spy = vi.spyOn(el.account!, "signTypedData");
  const errors: { code: string; message: string }[] = [];
  el.addEventListener("quietpay:error", (e) => errors.push((e as CustomEvent).detail));
  el.shadowRoot!.querySelector("button")!.click();
  await until(() => el.view === "error");
  await el.updateComplete;
  expect(el.errorCode).toBe("checkout_display_mismatch");
  expect(el.shadowRoot!.querySelector("[role=alert]")!.textContent).toBe(CHECKOUT_MISMATCH_MESSAGE);
  expect(errors[0]).toMatchObject({ code: "checkout_display_mismatch", message: CHECKOUT_MISMATCH_MESSAGE });
  expect(spy).not.toHaveBeenCalled();
  expect(calls.some((c) => c.endsWith("/v1/relay/pay"))).toBe(false);
  // The rejected order never replaced what the payer was looking at.
  expect(formatShown(el.order!)).toBe(shownText);
}

const formatShown = (o: Order) => `${(BigInt(o.amount) / 1_000_000n).toString()}.${(BigInt(o.amount) % 1_000_000n).toString().padStart(6, "0")} USDT`;

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("<quietpay-checkout> signs only the order it displayed", () => {
  for (const [field, swap] of Object.entries(SWAPS)) {
    it(`refuses when the ${field} is swapped between display and signing`, async () => {
      const calls = swappingRelayer(shown(), swap());
      // The display pin runs before the host-expectation checks, so every swap is reported as a display mismatch.
      await payAndExpectDisplayRefusal(mount({ router: FIXTURE_ROUTER }), calls);
    });
  }

  it("host attributes cannot bless a swap: expected-amount equal to the swapped amount is still refused", async () => {
    const calls = swappingRelayer(makeOrder({ id: ORDER_ID, amount: "1000000" }), makeOrder({ id: ORDER_ID, amount: "100000000" }));
    await payAndExpectDisplayRefusal(mount({ router: FIXTURE_ROUTER, "expected-amount": "100" }), calls);
  });

  it("host expected-payout equal to the swapped payout is still refused", async () => {
    const calls = swappingRelayer(shown(), SWAPS.payout!());
    await payAndExpectDisplayRefusal(mount({ router: FIXTURE_ROUTER, "expected-payout": OTHER_PAYOUT }), calls);
  });

  it("allows status/expiry changes and checksum-case differences, and signs the displayed values", async () => {
    const fresh = shown();
    fresh.expiresAt += 600;
    fresh.checkout.router = FIXTURE_ROUTER.toUpperCase().replace("0X", "0x");
    fresh.checkout.nonce = fresh.checkout.nonce.toUpperCase().replace("0X", "0x");
    const calls = swappingRelayer(shown(), fresh);
    const el = mount({ router: FIXTURE_ROUTER });
    await until(() => el.view === "ready" && !!el.account);
    const spy = vi.spyOn(el.account!, "signTypedData");
    el.shadowRoot!.querySelector("button")!.click();
    await until(() => calls.some((c) => c.endsWith("/v1/relay/pay")));
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = (spy.mock.calls[0]![0] as unknown as { message: { value: bigint; nonce: Hex } }).message;
    expect(msg.value).toBe(BigInt(shown().amount));
    expect(msg.nonce.toLowerCase()).toBe(shown().checkout.nonce.toLowerCase());
  });

  it("a pending order at pay time is followed without signing", async () => {
    const pending = { ...shown(), status: "pending" as const };
    const settled = { ...shown(), status: "settled" as const };
    let gets = 0;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      gets += 1;
      const body = gets === 1 ? shown() : gets === 2 ? pending : settled;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const el = mount({ router: FIXTURE_ROUTER });
    await until(() => el.view === "ready" && !!el.account);
    const spy = vi.spyOn(el.account!, "signTypedData");
    el.shadowRoot!.querySelector("button")!.click();
    await until(() => el.view === "settled");
    expect(spy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.endsWith("/v1/relay/pay"))).toBe(false);
  });
});

describe("verifyDisplayedOrder / pinDisplayedOrder", () => {
  const codeOf = (fn: () => void) => {
    try {
      fn();
      return "ok";
    } catch (e) {
      return e instanceof WidgetError ? `${e.code}:${e.message}` : "other";
    }
  };

  it("accepts the same order, a later status and a later expiry", () => {
    const pin = pinDisplayedOrder(shown());
    expect(Object.isFrozen(pin)).toBe(true);
    expect(codeOf(() => verifyDisplayedOrder(shown(), pin))).toBe("ok");
    expect(codeOf(() => verifyDisplayedOrder({ ...shown(), status: "pending", expiresAt: 1 }, pin))).toBe("ok");
  });

  const expectedField: Record<string, string> = {
    amount: "amount",
    fee: "fee",
    merchant: "merchant",
    payout: "payout",
    nonce: "nonce",
    token: "token",
    router: "router",
    chain: "chain",
    domain: "token domain",
  };
  for (const [field, swap] of Object.entries(SWAPS)) {
    it(`names the ${field} when it differs`, () => {
      expect(codeOf(() => verifyDisplayedOrder(swap(), pinDisplayedOrder(shown())))).toBe(
        `checkout_display_mismatch:checkout refused: ${expectedField[field]} differs from what was displayed`,
      );
    });
  }

  it("a different order id is refused", () => {
    const other = makeOrder({ id: ("0x" + "cd".repeat(32)) as Hex });
    expect(codeOf(() => verifyDisplayedOrder(other, pinDisplayedOrder(shown())))).toMatch(/^checkout_display_mismatch:.*order id/);
  });

  it("checkout.value / checkout.fee / checkout.payout are compared too, not only the top-level fields", () => {
    const pin = pinDisplayedOrder(shown());
    const v = shown();
    v.checkout.value = "100000000";
    expect(codeOf(() => verifyDisplayedOrder(v, pin))).toMatch(/amount differs/);
    const f = shown();
    f.checkout.fee = "90000";
    expect(codeOf(() => verifyDisplayedOrder(f, pin))).toMatch(/fee differs/);
    const p = shown();
    p.checkout.payout = OTHER_PAYOUT;
    expect(codeOf(() => verifyDisplayedOrder(p, pin))).toMatch(/payout differs/);
  });

  it("signCheckout with `displayed` refuses a swapped order without signing", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const spy = vi.spyOn(account, "signTypedData");
    const pin = pinDisplayedOrder(shown());
    await expect(
      signCheckout(account, SWAPS.amount!(), undefined, { expected: { router: FIXTURE_ROUTER, orderId: ORDER_ID }, displayed: pin }),
    ).rejects.toMatchObject({ code: "checkout_display_mismatch" });
    expect(spy).not.toHaveBeenCalled();
    await expect(signCheckout(account, shown(), undefined, { expected: { router: FIXTURE_ROUTER, orderId: ORDER_ID }, displayed: pin })).resolves.toMatchObject({
      orderId: ORDER_ID,
      amount: shown().amount,
    });
  });
});
