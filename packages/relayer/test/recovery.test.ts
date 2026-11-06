import { describe, expect, it, vi } from "vitest";
import { RelayerService } from "../src/service.js";
import { Db } from "../src/db.js";
import { makeEnv, newOrder, signFor, payer } from "./helpers.js";

const ctx = { ip: "203.0.113.1" };
const flush = () => new Promise(r => setTimeout(r, 0));

async function pending(over: Parameters<typeof makeEnv>[0] = {}) {
  const env = makeEnv(over);
  env.chain.receiptFails = true;
  const order = await newOrder(env.svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
  const request = await signFor(order, env.clock.t);
  const response = await env.svc.relayPay(request, ctx);
  await flush();
  return { ...env, order, request, response };
}

describe("P0 recovery and safety", () => {
  it("persists signed bytes and the gas reservation before a broadcast, retaining ambiguous sends", async () => {
    const e = makeEnv();
    e.chain.receiptFails = true;
    const order = await newOrder(e.svc);
    const original = e.chain.broadcast.bind(e.chain);
    e.chain.broadcast = async raw => {
      expect(e.db.getOrder(order.id)?.tx_hash).toBe(raw);
      expect(e.db.attempts(order.id)[0]?.raw).toBe(raw);
      expect(e.db.reservedSpend(0)).toBe(180_000_000_000_000n);
      await original(raw); // node accepted it, but its response was lost
      throw new Error("connection reset");
    };
    const req = await signFor(order, e.clock.t);
    const a = await e.svc.relayPay(req, ctx);
    expect(e.svc.getOrder(order.id).status).toBe("pending");
    expect((await e.svc.relayPay(req, ctx)).txHash).toBe(a.txHash);
    expect(e.chain.prepared).toHaveLength(1);
    await flush();
  });

  it("recovers after a database reopen and settles exactly one webhook", async () => {
    const e = await pending();
    // Reopen a serialized SQLite database: no process-local transaction state survives.
    const recoveredDb = new Db(e.db.raw.serialize());
    expect(recoveredDb.nonceFloor()).toBe(1);
    const svc = new RelayerService({ cfg: e.cfg, db: recoveredDb, chain: e.chain, now: () => e.clock.t });
    e.chain.receiptFails = false;
    await svc.recoverOrder(e.order.id);
    await svc.recoverOrder(e.order.id);
    expect(svc.getOrder(e.order.id).status).toBe("settled");
    expect(recoveredDb.dueDeliveries(e.clock.t)).toHaveLength(1);
    expect(e.chain.prepared).toHaveLength(1);
    recoveredDb.close();
  });

  it("releases a startup claim with no signed transaction, but leaves active claims alone", async () => {
    const e = makeEnv();
    const order = await newOrder(e.svc);
    const req = await signFor(order, e.clock.t);
    e.db.claimForRelay(order.id, req.payer, req.signature, req.validAfter, req.validBefore, e.clock.t);
    e.svc.recoverPending();
    expect(e.svc.getOrder(order.id).status).toBe("pending");
    e.svc.recoverPending(true);
    expect(e.svc.getOrder(order.id).status).toBe("created");
  });

  it("replaces a slow payment at the same nonce with bounded gas price and one reservation", async () => {
    const e = await pending({ maxReplacements: 1 });
    const first = e.db.attempts(e.order.id)[0]!;
    e.clock.t += 31;
    await Promise.all([e.svc.recoverOrder(e.order.id), e.svc.recoverOrder(e.order.id)]);
    const attempts = e.db.attempts(e.order.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.nonce).toBe(first.nonce);
    expect(attempts[1]?.gas_price).toBe("1125000000");
    expect(e.db.reservedSpend(0)).toBe(202_500_000_000_000n);
    e.clock.t += 31;
    await e.svc.recoverOrder(e.order.id);
    expect(e.chain.prepared).toHaveLength(2);
    e.chain.receiptFails = false; // the original mined before the replacement
    await e.svc.recoverOrder(e.order.id);
    expect(e.svc.getOrder(e.order.id).txHash).toBe(first.hash);
    expect(e.db.spentSince(0)).toBe(150_000_000_000_000n);
  });

  it.each([
    { maxGasPrice: 1_000_000_000n },
    { lossBudgetWei: 180_000_000_000_000n },
  ])("does not replace beyond configured price or loss limits: %#", async over => {
    const e = await pending(over);
    e.clock.t += 31;
    await e.svc.recoverOrder(e.order.id);
    expect(e.chain.prepared).toHaveLength(1);
  });

  it("counts old pending reservations even after an hour", async () => {
    const e = await pending({ lossBudgetWei: 200_000_000_000_000n });
    e.clock.t += 3601;
    const order = await newOrder(e.svc);
    await expect(e.svc.relayPay(await signFor(order, e.clock.t), ctx)).rejects.toMatchObject({ code: "relayer_paused" });
    expect(e.chain.prepared).toHaveLength(1);
    e.chain.receiptFails = false;
    await e.svc.recoverOrder(e.order.id);
    expect(e.db.spentSince(e.clock.t - 3600)).toBe(150_000_000_000_000n);
  });

  it("pause blocks recovery broadcasts and replacements while receipts still settle", async () => {
    const e = await pending();
    const broadcast = vi.spyOn(e.chain, "broadcast");
    e.svc.setLocalPaused(true);
    e.clock.t += 31;
    await e.svc.recoverOrder(e.order.id);
    expect(broadcast).not.toHaveBeenCalled();
    expect(e.chain.prepared).toHaveLength(1);
    e.chain.receiptFails = false;
    await e.svc.recoverOrder(e.order.id);
    expect(e.svc.getOrder(e.order.id).status).toBe("settled");
  });

  it("concurrent distinct orders cannot overshoot the payer cap", async () => {
    const e = makeEnv({ payerCap: 30_000_000n });
    e.chain.receiptFails = true;
    const orders = await Promise.all([newOrder(e.svc), newOrder(e.svc)]);
    const reqs = await Promise.all(orders.map(o => signFor(o, e.clock.t)));
    const results = await Promise.allSettled(reqs.map(r => e.svc.relayPay(r, ctx)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(e.chain.prepared).toHaveLength(1);
    expect(e.db.payerVolume(payer.address, 0)).toBe(25_000_000n);
    await flush();
  });

  it("all concurrent identical requests receive the same transaction hash", async () => {
    const e = makeEnv();
    const order = await newOrder(e.svc);
    const req = await signFor(order, e.clock.t);
    const results = await Promise.all(Array.from({ length: 10 }, () => e.svc.relayPay(req, ctx)));
    expect(new Set(results.map(r => r.txHash)).size).toBe(1);
    expect(e.chain.prepared).toHaveLength(1);
    await flush();
  });

  it("enforces the gas limit before signing", async () => {
    const e = makeEnv({ maxGasLimit: 179_999n });
    const o = await newOrder(e.svc);
    await expect(e.svc.relayPay(await signFor(o, e.clock.t), ctx)).rejects.toMatchObject({ code: "relayer_paused" });
    expect(e.chain.prepared).toHaveLength(0);
  });

  it("rate limits a payer across IPs and a merchant across payers", async () => {
    const e = makeEnv({ rateLimitPerMinute: 1 });
    const first = await newOrder(e.svc, "1000000");
    await e.svc.relayPay(await signFor(first, e.clock.t), ctx);
    const second = await newOrder(e.svc, "1000000");
    await expect(e.svc.relayPay(await signFor(second, e.clock.t), { ip: "203.0.113.2" })).rejects.toMatchObject({ code: "rate_limited" });
    // Different signed payer, same merchant.
    const { privateKeyToAccount } = await import("viem/accounts");
    const { buildCheckoutAuthorization } = await import("@quietpay/shared");
    const other = privateKeyToAccount(("0x" + "c3".repeat(32)) as `0x${string}`);
    const validAfter = e.clock.t - 5, validBefore = e.clock.t + 300;
    const signature = await other.signTypedData(buildCheckoutAuthorization({ from: other.address,
      router: e.cfg.router, value: BigInt(second.amount), nonce: second.checkout.nonce as `0x${string}`,
      validAfter: BigInt(validAfter), validBefore: BigInt(validBefore) }));
    await expect(e.svc.relayPay({ orderId: second.id, payer: other.address, validAfter, validBefore, signature }, { ip: "203.0.113.3" })).rejects.toMatchObject({ code: "rate_limited" });
    await flush();
  });

  it("ignores a stale receipt callback after a failed order is retried at a new nonce", async () => {
    const e = await pending();
    const firstHash = e.response.txHash! as `0x${string}`;
    e.db.setStatus(e.order.id, "failed");
    const req = await signFor(e.order, e.clock.t, { validBefore: e.clock.t + 250 });
    const retry = await e.svc.relayPay(req, ctx);
    await flush();
    await e.svc.track(e.order.id, firstHash, { status: "success", gasUsed: 150_000n,
      effectiveGasPrice: 1_000_000_000n, blockNumber: 1n });
    expect(e.svc.getOrder(e.order.id)).toMatchObject({ status: "pending", txHash: retry.txHash });
  });

  it("honours a pause issued while simulation was in flight", async () => {
    const e = makeEnv();
    const simulate = e.chain.simulatePay.bind(e.chain);
    e.chain.simulatePay = async () => { e.svc.setLocalPaused(true); return simulate(); };
    const o = await newOrder(e.svc);
    await expect(e.svc.relayPay(await signFor(o, e.clock.t), ctx)).rejects.toMatchObject({ code: "relayer_paused" });
    expect(e.chain.prepared).toHaveLength(0);
  });

  it("reports balance and alerts once per low-balance transition", async () => {
    const e = makeEnv();
    const log = vi.fn();
    const svc = new RelayerService({ cfg: e.cfg, db: e.db, chain: e.chain, log });
    e.chain.balance = 1n;
    await svc.refreshBalance(); await svc.refreshBalance();
    expect(svc.metrics()).toMatchObject({ balanceWbt: "0.000000000000000001", lowBalance: true });
    expect(log).toHaveBeenCalledTimes(1);
    e.chain.balance = 10n ** 18n;
    await svc.refreshBalance();
    expect(svc.metrics().lowBalance).toBe(false);
  });
});
