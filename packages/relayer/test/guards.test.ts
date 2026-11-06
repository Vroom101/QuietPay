import { describe, expect, it } from "vitest";
import { QuietpayError, type ErrorCode } from "@quietpay/shared";
import { FakeChain, MERCHANT_ID, PAYER_KEY, makeEnv, newOrder, payer, signFor } from "./helpers.js";

const ctx = { ip: "203.0.113.7" };

async function expectCode(p: Promise<unknown>, code: ErrorCode) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err, `expected ${code}`).toBeInstanceOf(QuietpayError);
  expect((err as QuietpayError).code).toBe(code);
}

describe("guard pipeline: every guard rejects before any broadcast", () => {
  it("order_not_found for an unknown order", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t);
    await expectCode(svc.relayPay({ ...req, orderId: ("0x" + "ee".repeat(32)) as `0x${string}` }, ctx), "order_not_found");
    expect(chain.sent).toHaveLength(0);
  });

  it("order_expired once the order has expired", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t);
    clock.t += 901;
    const late = await signFor(order, clock.t);
    await expectCode(svc.relayPay(late, ctx), "order_expired");
    expect(req.signature).not.toBe(late.signature);
    expect(chain.sent).toHaveLength(0);
  });

  it("order_expired when the payer's approval window already closed", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t, { validAfter: clock.t - 400, validBefore: clock.t - 100 });
    await expectCode(svc.relayPay(req, ctx), "order_expired");
    expect(chain.sent).toHaveLength(0);
  });

  it("bad_signature for a signature by someone else", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t, { key: ("0x" + "c3".repeat(32)) as `0x${string}` });
    await expectCode(svc.relayPay(req, ctx), "bad_signature");
    expect(chain.sent).toHaveLength(0);
    expect(chain.simulations).toBe(0);
  });

  it("bad_signature when the payer signed a different amount", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t, { value: 1n });
    await expectCode(svc.relayPay(req, ctx), "bad_signature");
    expect(chain.sent).toHaveLength(0);
  });

  it("bad_signature when the nonce does not bind this order", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t, { nonce: ("0x" + "00".repeat(32)) as `0x${string}` });
    await expectCode(svc.relayPay(req, ctx), "bad_signature");
    expect(chain.sent).toHaveLength(0);
  });

  it("bad_signature when the window is longer than ten minutes", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t, { validAfter: clock.t - 5, validBefore: clock.t + 700 });
    await expectCode(svc.relayPay(req, ctx), "bad_signature");
    expect(chain.sent).toHaveLength(0);
  });

  it("amount_mismatch when the client echoes a different price", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t);
    await expectCode(svc.relayPay({ ...req, amount: "24000000" }, ctx), "amount_mismatch");
    expect(chain.sent).toHaveLength(0);
  });

  it("fee_over_cap when the merchant lowered its cap after the order was created", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    chain.merchant = { ...chain.merchant, maxRelayFee: 10_000n };
    const req = await signFor(order, clock.t);
    await expectCode(svc.relayPay(req, ctx), "fee_over_cap");
    expect(chain.sent).toHaveLength(0);
  });

  it("order_expired when the registry payout changed after the order was created", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    chain.merchant = { ...chain.merchant, payout: "0x9999999999999999999999999999999999999999" };
    const req = await signFor(order, clock.t);
    await expectCode(svc.relayPay(req, ctx), "order_expired");
    expect(chain.sent).toHaveLength(0);
  });

  it("relayer_paused when the router is paused on chain", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    chain.paused = true;
    await expectCode(svc.relayPay(await signFor(order, clock.t), ctx), "relayer_paused");
    expect(chain.sent).toHaveLength(0);
  });

  it("relayer_paused when the operator pauses the relayer", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    svc.setLocalPaused(true);
    await expectCode(svc.relayPay(await signFor(order, clock.t), ctx), "relayer_paused");
    svc.setLocalPaused(false);
    await svc.relayPay(await signFor(order, clock.t), ctx);
    expect(chain.sent).toHaveLength(1);
  });

  it("rate_limited after too many requests from one client", async () => {
    const { svc, chain, clock } = makeEnv({ rateLimitPerMinute: 3 });
    const order = await newOrder(svc);
    const junk = { ...(await signFor(order, clock.t)), orderId: ("0x" + "ee".repeat(32)) as `0x${string}` };
    for (let i = 0; i < 3; i++) await expectCode(svc.relayPay(junk, ctx), "order_not_found");
    await expectCode(svc.relayPay(junk, ctx), "rate_limited");
    expect(chain.sent).toHaveLength(0);
  });

  it("rate_limited when a payer exceeds the per-payer cap", async () => {
    const { svc, chain, clock } = makeEnv({ payerCap: 30_000_000n });
    const o1 = await newOrder(svc, "25000000");
    await svc.relayPay(await signFor(o1, clock.t), ctx);
    const o2 = await newOrder(svc, "25000000");
    await expectCode(svc.relayPay(await signFor(o2, clock.t), ctx), "rate_limited");
    expect(chain.sent).toHaveLength(1);
  });

  it("already_settled when the router already holds a receipt", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    chain.settledOnChain = true;
    await expectCode(svc.relayPay(await signFor(order, clock.t), ctx), "already_settled");
    expect(chain.sent).toHaveLength(0);
  });

  it("simulation_failed when eth_call reverts", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    chain.simulateFails = true;
    await expectCode(svc.relayPay(await signFor(order, clock.t), ctx), "simulation_failed");
    expect(chain.sent).toHaveLength(0);
    // The order is released so the payer can retry once the problem is fixed.
    chain.simulateFails = false;
    await svc.relayPay(await signFor(order, clock.t), ctx);
    expect(chain.sent).toHaveLength(1);
  });

  it("relayer_paused when gas price is over MAX_GAS_PRICE", async () => {
    const { svc, chain, clock } = makeEnv({ maxGasPrice: 500_000_000n });
    const order = await newOrder(svc);
    await expectCode(svc.relayPay(await signFor(order, clock.t), ctx), "relayer_paused");
    expect(chain.sent).toHaveLength(0);
  });

  it("relayer_paused once the hourly loss budget is exhausted", async () => {
    // One relay costs 150k*1.2*1gwei = 0.00018 WBT. Budget allows exactly two.
    const { svc, chain, clock } = makeEnv({ lossBudgetWei: 400_000_000_000_000n });
    for (let i = 0; i < 2; i++) {
      const o = await newOrder(svc, "1000000");
      await svc.relayPay(await signFor(o, clock.t), ctx);
    }
    const third = await newOrder(svc, "1000000");
    await expectCode(svc.relayPay(await signFor(third, clock.t), ctx), "relayer_paused");
    expect(chain.sent).toHaveLength(2);
    // The budget is rolling: an hour later it frees up.
    clock.t += 3601;
    const later = await newOrder(svc, "1000000");
    await svc.relayPay(await signFor(later, clock.t), ctx);
    expect(chain.sent).toHaveLength(3);
  });
});

describe("idempotency and state", () => {
  it("a repeated relay/pay for the same order returns the same hash and broadcasts once", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t);
    const a = await svc.relayPay(req, ctx);
    const b = await svc.relayPay(req, ctx);
    expect(a.txHash).toBeDefined();
    expect(b.txHash).toBe(a.txHash);
    expect(chain.sent).toHaveLength(1);
  });

  it("concurrent identical requests broadcast once", async () => {
    const { svc, chain, clock } = makeEnv();
    const order = await newOrder(svc);
    const req = await signFor(order, clock.t);
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => svc.relayPay(req, ctx)));
    expect(chain.sent).toHaveLength(1);
    const hashes = new Set(results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ txHash?: string }>).value.txHash));
    expect(hashes.size).toBe(1);
  });

  it("a different signature for a pending order is already_settled", async () => {
    const { svc, chain, clock } = makeEnv();
    chain.holdReceipt = true;
    const order = await newOrder(svc);
    await svc.relayPay(await signFor(order, clock.t), ctx);
    const second = await signFor(order, clock.t, { validBefore: clock.t + 200 });
    await expectCode(svc.relayPay(second, ctx), "already_settled");
    expect(chain.sent).toHaveLength(1);
  });

  it("moves pending -> settled and queues a webhook", async () => {
    const { svc, chain, db, clock } = makeEnv();
    const order = await newOrder(svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    const res = await svc.relayPay(await signFor(order, clock.t), ctx);
    expect(res.status).toBe("pending");
    await new Promise((r) => setTimeout(r, 10));
    const got = svc.getOrder(order.id);
    expect(got.status).toBe("settled");
    expect(got.payer?.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(got.explorerUrl).toContain(res.txHash!);
    const due = db.dueDeliveries(clock.t);
    expect(due).toHaveLength(1);
    expect(JSON.parse(due[0]!.body).type).toBe("payment.settled");
    expect(chain.sent[0]!.fee).toBe(50_000n);
  });

  it("a reverted transaction fails the order, queues payment.failed and allows a retry", async () => {
    const { svc, chain, db, clock } = makeEnv();
    chain.receiptStatus = "reverted";
    const order = await newOrder(svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    await svc.relayPay(await signFor(order, clock.t), ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.getOrder(order.id).status).toBe("failed");
    expect(JSON.parse(db.dueDeliveries(clock.t)[0]!.body).type).toBe("payment.failed");
    chain.receiptStatus = "success";
    await svc.relayPay(await signFor(order, clock.t, { validBefore: clock.t + 250 }), ctx);
    await new Promise((r) => setTimeout(r, 10));
    expect(svc.getOrder(order.id).status).toBe("settled");
  });

  it("unregistered merchants cannot create orders", async () => {
    const { svc, chain } = makeEnv();
    chain.merchant = { ...chain.merchant, payout: "0x0000000000000000000000000000000000000000" };
    await expectCode(newOrder(svc), "simulation_failed");
  });

  it("caps the order fee at the merchant's maxRelayFee", async () => {
    const { svc, chain } = makeEnv();
    chain.merchant = { ...chain.merchant, maxRelayFee: 20_000n };
    expect((await newOrder(svc)).fee).toBe("20000");
  });
});

describe("drain attempt", () => {
  it("thousands of cheap invalid requests spend nothing and stay under the loss budget", async () => {
    const { svc, chain, db, clock, cfg } = makeEnv({ rateLimitPerMinute: 100_000 });
    const order = await newOrder(svc);
    const good = await signFor(order, clock.t);
    const attackers = [
      { ...good, signature: ("0x" + "00".repeat(65)) as `0x${string}` },
      { ...good, orderId: ("0x" + "ee".repeat(32)) as `0x${string}` },
      { ...good, amount: "1" },
      { ...(await signFor(order, clock.t, { key: ("0x" + "c3".repeat(32)) as `0x${string}` })) },
      { ...(await signFor(order, clock.t, { value: 1n })) },
    ];
    let accepted = 0;
    for (let i = 0; i < 2000; i++) {
      // Vary the order id so the per-order limiter does not mask the other guards.
      const base = attackers[i % attackers.length]!;
      try {
        await svc.relayPay(base, { ip: `198.51.100.${i % 250}` });
        accepted += 1;
      } catch {
        /* rejected as expected */
      }
    }
    expect(accepted).toBe(0);
    expect(chain.sent).toHaveLength(0);
    expect(db.spentSince(0)).toBe(0n);
    expect(db.spentSince(0)).toBeLessThan(cfg.lossBudgetWei);
    expect(svc.metrics().rejected).not.toEqual({});
  });

  it("valid-looking requests that fail simulation never get broadcast", async () => {
    const { svc, chain, db, clock } = makeEnv({ rateLimitPerMinute: 100_000 });
    chain.simulateFails = true;
    for (let i = 0; i < 200; i++) {
      const o = await newOrder(svc, "1000000");
      await svc.relayPay(await signFor(o, clock.t), { ip: `192.0.2.${i % 250}` }).catch(() => undefined);
    }
    expect(chain.sent).toHaveLength(0);
    expect(db.spentSince(0)).toBe(0n);
  });

  it("even if every request were valid, total spend is capped at the hourly budget", async () => {
    const { svc, chain, db, clock, cfg } = makeEnv({ rateLimitPerMinute: 100_000, payerCap: 10n ** 12n, lossBudgetWei: 2_000_000_000_000_000n }); // 0.002 WBT, about 11 to 13 relays
    for (let i = 0; i < 50; i++) {
      const o = await newOrder(svc, "1000000");
      await svc.relayPay(await signFor(o, clock.t), { ip: `192.0.2.${i}` }).catch(() => undefined);
    }
    expect(db.spentSince(0)).toBeLessThanOrEqual(cfg.lossBudgetWei);
    expect(chain.sent.length).toBeLessThanOrEqual(13); // budget / actual gas used per relay
    expect(chain.sent.length).toBeGreaterThan(0);
  });
});

// keep helper imports referenced for readers
void FakeChain;
void MERCHANT_ID;
void PAYER_KEY;
