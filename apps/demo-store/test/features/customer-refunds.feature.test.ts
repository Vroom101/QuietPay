import { afterEach, describe, expect, it } from "vitest";
import { ORDER_TOKEN_HEADER } from "@quietpay/shared";
import { hex32, world } from "../helpers-customer-refunds.js";

let w: ReturnType<typeof world>;
afterEach(async () => { await w?.close(); });

describe("Feature: customer-facing refund status", () => {
  it("Scenario: a customer sees a pending then completed refund", async () => {
    // Given a customer who paid 50 USDT and holds the order token from checkout
    w = world();
    const a = await w.checkout();
    await w.settle(a.orderId);
    expect((await w.status(a.orderId, a.token)).json()).toMatchObject({ status: "settled", totalRefunded: "0", remaining: "50000000", refunds: [] });
    // When the merchant starts a 20 USDT refund and the store reconciles with the relayer
    w.refunds.set(a.orderId, [{ id: hex32(1), orderId: a.orderId, amount: "20000000", refundIndex: 0, status: "pending", createdAt: 1_800_000_100 } as never]);
    w.advance(61_000);
    // Then the customer sees it as pending and nothing is counted as refunded yet
    const pending = (await w.status(a.orderId, a.token)).json();
    expect(pending.refunds).toEqual([{ amount: "20000000", status: "pending", createdAt: 1_800_000_100 }]);
    expect(pending.totalRefunded).toBe("0");
    // When the payment.refunded webhook arrives for that refund
    await w.post(w.refundEvent(a.orderId, 0, "20000000", "20000000"));
    // Then it is completed, with a transaction hash and the remaining balance
    const done = (await w.status(a.orderId, a.token)).json();
    expect(done).toMatchObject({ status: "partially_refunded", totalRefunded: "20000000", remaining: "30000000", currency: "USDT" });
    expect(done.refunds).toHaveLength(1);
    expect(done.refunds[0]).toMatchObject({ amount: "20000000", status: "settled", txHash: hex32(0xcafe00) });
  });

  it("Scenario: a customer cannot read another order", async () => {
    // Given two customers with their own orders
    w = world();
    const alice = await w.checkout(); const bob = await w.checkout();
    await w.settle(alice.orderId); await w.settle(bob.orderId);
    // When Bob asks for Alice's order with his token, with no token, or with the token in the URL
    const withBobToken = await w.status(alice.orderId, bob.token);
    const withNone = await w.status(alice.orderId);
    const inUrl = await w.status(alice.orderId, undefined, "10.0.0.9", `?token=${alice.token}`);
    // Then he gets the same not-found answer as for an order that does not exist (or a 400 for the URL token)
    const nothing = await w.status(hex32(0xabc));
    expect([withBobToken.body, withNone.body]).toEqual([nothing.body, nothing.body]);
    expect([withBobToken.statusCode, withNone.statusCode, nothing.statusCode]).toEqual([404, 404, 404]);
    expect(inUrl.statusCode).toBe(400);
    // And Alice, with her own header token, can read hers
    expect((await w.status(alice.orderId, alice.token)).statusCode).toBe(200);
    expect(ORDER_TOKEN_HEADER).toBe("Quietpay-Order-Token");
  });

  it("Scenario: a replayed webhook changes nothing", async () => {
    // Given an order with one 10 USDT refund already applied
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    const event = w.refundEvent(a.orderId, 0, "10000000", "10000000");
    expect((await w.post(event)).json()).toEqual({ received: true });
    const before = (await w.status(a.orderId, a.token)).body;
    // When the same signed delivery is sent again, and again with a fresh signature
    const replay = await w.post(event);
    const resigned = await w.post(event, Math.floor(Date.now() / 1000) + 1);
    // Then both are recognised as duplicates and the customer's view is byte-identical
    expect(replay.json()).toEqual({ received: true, duplicate: true });
    expect(resigned.json()).toEqual({ received: true, duplicate: true });
    expect((await w.status(a.orderId, a.token)).body).toBe(before);
  });

  it("Scenario: a malformed webhook is refused and the customer view is untouched", async () => {
    // Given a settled order
    w = world();
    const a = await w.checkout(); await w.settle(a.orderId);
    const before = (await w.status(a.orderId, a.token)).body;
    // When an unsigned refund event arrives
    const r = await w.postRaw(JSON.stringify(w.refundEvent(a.orderId, 0, "10000000", "10000000")));
    // Then it is rejected and nothing changed
    expect(r.statusCode).toBe(400);
    expect((await w.status(a.orderId, a.token)).body).toBe(before);
  });
});
