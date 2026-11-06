import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  QUALIFYING_CHAIN_ID,
  QUALIFYING_USDT,
  computePayNonce,
  getQualifyingDeployment,
  type Order,
} from "@quietpay/shared";
import { FIXTURE_ROUTER, makeOrder } from "@quietpay/shared/fixtures";
import { MAX_WIDGET_WINDOW_SECONDS, WidgetError, signCheckout, verifyCheckout, type ExpectedCheckout } from "../src/client.js";

const ATTACKER = "0x000000000000000000000000000000000000dEaD";
const now = 1_800_000_100;

/** The mock fixtures use a placeholder router; everything else already matches the qualifying chain/token/domain. */
const EXPECTED: ExpectedCheckout = { router: FIXTURE_ROUTER };

const clone = (o: Order): Order => JSON.parse(JSON.stringify(o)) as Order;

/** Rewrites the nonce so it is consistent with the (tampered) order fields. */
function renonce(o: Order): Order {
  o.checkout.nonce = computePayNonce({
    merchantId: o.merchantId as `0x${string}`,
    orderId: o.id as `0x${string}`,
    payout: o.checkout.payout as `0x${string}`,
    value: BigInt(o.checkout.value),
    fee: BigInt(o.checkout.fee),
  });
  return o;
}

function account() {
  const a = privateKeyToAccount(generatePrivateKey());
  const spy = vi.spyOn(a, "signTypedData");
  return { a, spy };
}

async function expectRefused(order: Order, code: string, expected: ExpectedCheckout = EXPECTED) {
  expect(() => verifyCheckout(order, expected)).toThrowError(WidgetError);
  try {
    verifyCheckout(order, expected);
  } catch (e) {
    expect((e as WidgetError).code).toBe(code);
  }
  const { a, spy } = account();
  await expect(signCheckout(a, order, now, { expected })).rejects.toMatchObject({ name: "WidgetError", code });
  expect(spy).not.toHaveBeenCalled();
}

describe("verifyCheckout: an honest order passes", () => {
  it("accepts the fixture order with the fixture router", () => {
    expect(() => verifyCheckout(makeOrder(), EXPECTED)).not.toThrow();
  });

  it("defaults: chain 1874, official USDT, router from the qualifying deployment, Tether USD / 1", () => {
    const o = makeOrder();
    o.checkout.router = getQualifyingDeployment().router;
    expect(o.checkout.chainId).toBe(QUALIFYING_CHAIN_ID);
    expect(o.checkout.token.toLowerCase()).toBe(QUALIFYING_USDT.toLowerCase());
    expect(() => verifyCheckout(o)).not.toThrow();
  });

  it("by default refuses the fixture router (not the deployed router)", async () => {
    await expectRefused(makeOrder(), "checkout_router_mismatch", {});
  });

  it("matches addresses case-insensitively", () => {
    const o = makeOrder();
    o.checkout.token = o.checkout.token.toLowerCase();
    expect(() => verifyCheckout(o, { router: FIXTURE_ROUTER.toUpperCase().replace("0X", "0x") })).not.toThrow();
  });

  it("signs when verification passes", async () => {
    const { a, spy } = account();
    const req = await signCheckout(a, makeOrder(), now, { expected: EXPECTED });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(req.validBefore - now).toBeLessThanOrEqual(MAX_WIDGET_WINDOW_SECONDS);
  });

  it("accepts overrides for a local chain", () => {
    const o = makeOrder();
    o.checkout.chainId = 31337;
    o.checkout.token = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
    o.checkout.domain = { name: "Local USD", version: "2" };
    expect(() =>
      verifyCheckout(o, {
        chainId: 31337,
        token: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        router: FIXTURE_ROUTER,
        domainName: "Local USD",
        domainVersion: "2",
      }),
    ).not.toThrow();
  });

  it("a non-qualifying chain without an explicit router is a config error, never a silent default", async () => {
    const o = makeOrder();
    o.checkout.chainId = 31337;
    await expectRefused(o, "checkout_config_invalid", { chainId: 31337 });
  });
});

describe("verifyCheckout: each tampered field is refused and nothing is signed", () => {
  it("chainId", async () => {
    const o = clone(makeOrder());
    o.checkout.chainId = 1;
    await expectRefused(o, "checkout_chain_mismatch");
  });

  it("token", async () => {
    const o = clone(makeOrder());
    o.checkout.token = ATTACKER;
    await expectRefused(o, "checkout_token_mismatch");
  });

  it("router (an attacker contract as `to`)", async () => {
    const o = clone(makeOrder());
    o.checkout.router = ATTACKER;
    await expectRefused(o, "checkout_router_mismatch");
  });

  it("domain name", async () => {
    const o = clone(makeOrder());
    o.checkout.domain = { name: "Tether USD Evil", version: "1" };
    await expectRefused(o, "checkout_domain_mismatch");
  });

  it("domain version", async () => {
    const o = clone(makeOrder());
    o.checkout.domain = { name: "Tether USD", version: "2" };
    await expectRefused(o, "checkout_domain_mismatch");
  });

  it("nonce (not derived from the order fields)", async () => {
    const o = clone(makeOrder());
    o.checkout.nonce = "0x" + "11".repeat(32);
    await expectRefused(o, "checkout_nonce_mismatch");
  });

  it("nonce bound to a different order id", async () => {
    const o = clone(makeOrder());
    o.checkout.nonce = computePayNonce({
      merchantId: o.merchantId as `0x${string}`,
      orderId: ("0x" + "ee".repeat(32)) as `0x${string}`,
      payout: o.payout as `0x${string}`,
      value: BigInt(o.amount),
      fee: BigInt(o.fee),
    });
    await expectRefused(o, "checkout_nonce_mismatch");
  });

  it("amount: checkout.value differs from the displayed order amount", async () => {
    const o = clone(makeOrder());
    o.checkout.value = "250000000";
    renonce(o);
    await expectRefused(o, "checkout_amount_mismatch");
  });

  it("amount: consistent but differs from the expected amount the shop set", async () => {
    const o = renonce(makeOrder({ amount: "26000000" }));
    o.checkout.value = "26000000";
    renonce(o);
    await expectRefused(o, "checkout_amount_mismatch", { ...EXPECTED, amount: 25_000_000n });
    expect(() => verifyCheckout(makeOrder(), { ...EXPECTED, amount: 25_000_000n })).not.toThrow();
  });

  it("fee: checkout.fee differs from order.fee", async () => {
    const o = clone(makeOrder());
    o.checkout.fee = "60000";
    renonce(o);
    await expectRefused(o, "checkout_fee_mismatch");
  });

  it("fee: equal to the value (merchant would receive nothing)", async () => {
    const o = clone(makeOrder());
    o.fee = o.amount;
    o.checkout.fee = o.amount;
    renonce(o);
    await expectRefused(o, "checkout_fee_invalid");
  });

  it("fee: greater than the value", async () => {
    const o = clone(makeOrder());
    o.fee = "30000000";
    o.checkout.fee = "30000000";
    renonce(o);
    await expectRefused(o, "checkout_fee_invalid");
  });

  it("payout: checkout.payout differs from order.payout", async () => {
    const o = clone(makeOrder());
    o.checkout.payout = ATTACKER;
    renonce(o);
    await expectRefused(o, "checkout_payout_mismatch");
  });

  it("payout: consistent attacker payout is refused when the shop pins its payout", async () => {
    const o = clone(makeOrder());
    o.payout = ATTACKER;
    o.checkout.payout = ATTACKER;
    renonce(o);
    await expectRefused(o, "checkout_payout_mismatch", { ...EXPECTED, payout: makeOrder().payout });
  });

  it("order id: relayer returns a different order than the one requested", async () => {
    await expectRefused(makeOrder(), "checkout_order_mismatch", { ...EXPECTED, orderId: "0x" + "ee".repeat(32) });
  });
});

describe("signCheckout validity window", () => {
  it("default window ends at most 5 minutes from now", async () => {
    const { a } = account();
    const req = await signCheckout(a, makeOrder(), now, { expected: EXPECTED });
    expect(req.validBefore).toBe(now + 300);
    expect(req.validAfter).toBe(now - 5);
    expect(MAX_WIDGET_WINDOW_SECONDS).toBe(300);
  });

  it.each([301, 600, 0, -1, 1.5])("refuses a window of %s seconds without signing", async (w) => {
    const { a, spy } = account();
    await expect(signCheckout(a, makeOrder(), now, { expected: EXPECTED, windowSeconds: w })).rejects.toMatchObject({
      code: "checkout_window_invalid",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});
