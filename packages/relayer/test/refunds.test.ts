import { describe, expect, it } from "vitest";
import { buildRefundAuthorization, type RelayRefundRequest } from "@quietpay/shared";
import { WebhookEvent } from "@quietpay/shared/webhook";
import { buildServer } from "../src/server.js";
import { RelayerService } from "../src/service.js";
import { Db } from "../src/db.js";
import { makeEnv, newOrder, signFor, MERCHANT_ID, refundSigner, payer, ROUTER, USDT, PAYER_KEY } from "./helpers.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const flush = () => new Promise(r => setTimeout(r, 0));
async function setup(over: Parameters<typeof makeEnv>[0] = {}) {
  const e = makeEnv(over);
  const order = await newOrder(e.svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
  const pay = await signFor(order, e.clock.t);
  await e.svc.relayPay(pay, { ip: "203.0.113.1" });
  await flush();
  return { ...e, order, pay };
}
async function signed(e: Awaited<ReturnType<typeof setup>>, over: Partial<RelayRefundRequest> = {}, signingPayer = payer.address, key = refundSigner) {
  const amount = over.amount ?? "5000000", index = over.refundIndex ?? 0;
  const validAfter = over.validAfter ?? e.clock.t - 5, validBefore = over.validBefore ?? e.clock.t + 300;
  const signature = await key.signTypedData(buildRefundAuthorization({ merchantId: MERCHANT_ID,
    orderId: e.order.id as Hex, payer: signingPayer, refundSigner: refundSigner.address, router: ROUTER,
    amount: BigInt(amount), refundIndex: BigInt(index), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), token: e.cfg.usdt, chainId: e.cfg.chainId, domainName: e.cfg.tokenDomain.name, domainVersion: e.cfg.tokenDomain.version }));
  return { orderId: e.order.id, amount, refundIndex: index, validAfter, validBefore, signature, ...over };
}
const submit = (e: Awaited<ReturnType<typeof setup>>, req: RelayRefundRequest) => e.svc.refunds.submit(MERCHANT_ID, req, "203.0.113.1");

// Fake-chain receipts are explicit; contract/E2E tests verify actual token movement.
describe("gasless partial refunds", () => {
  it("uses the configured token and domain for both payments and refunds", async () => {
    const e = await setup({ usdt: "0x9999999999999999999999999999999999999999", tokenDomain: { name: "DemoUSDT", version: "2" } });
    expect(e.order.checkout).toMatchObject({ token: e.cfg.usdt, domain: e.cfg.tokenDomain });
    expect(await e.svc.refunds.context(MERCHANT_ID, e.order.id as Hex)).toMatchObject({ token: e.cfg.usdt, domain: e.cfg.tokenDomain });
    const r = await submit(e, await signed(e));
    await flush();
    expect(e.svc.refunds.get(MERCHANT_ID, r.id).status).toBe("settled");
    e.db.close();
  });
  it("settles partial and full refunds without overwriting the original payment hash", async () => {
    const e = await setup();
    const paymentHash = e.svc.getOrder(e.order.id).txHash;
    const r = await submit(e, await signed(e));
    await flush();
    expect(e.svc.refunds.get(MERCHANT_ID, r.id).status).toBe("settled");
    expect(e.svc.getOrder(e.order.id)).toMatchObject({ status: "partially_refunded", refunded: "5000000", refundCount: 1, txHash: paymentHash });
    const event = e.db.dueDeliveries(e.clock.t).map(d => JSON.parse(d.body)).find(x => x.type === "payment.refunded");
    expect(WebhookEvent.parse(event).data).toMatchObject({ refundAmount: "5000000", totalRefunded: "5000000", refundIndex: 0, refundId: r.id });
    e.chain.orderReceipts.set(e.order.id, { payer: payer.address, value: 25_000_000n, refunded: 5_000_000n, refundCount: 1n, settled: true });
    await submit(e, await signed(e, { amount: "20000000", refundIndex: 1 }));
    await flush();
    expect(e.svc.getOrder(e.order.id)).toMatchObject({ status: "refunded", refunded: "25000000", refundCount: 2 });
    expect(e.db.payerVolume(payer.address, 0)).toBe(25_000_000n);
    await expect(e.svc.relayPay(await signFor(e.order, e.clock.t, { validBefore: e.clock.t + 250 }), { ip: "203.0.113.2" })).rejects.toMatchObject({ code: "already_settled" });
  });

  it("requires merchant authentication and denies another merchant access", async () => {
    const e = await setup(), app = buildServer(e.svc), payload = await signed(e);
    expect((await app.inject({ method: "POST", url: "/v1/relay/refund", payload })).statusCode).toBe(401);
    e.cfg.apiKeys.set("foreign", ("0x" + "02".repeat(32)) as Hex);
    expect((await app.inject({ method: "POST", url: "/v1/relay/refund", payload, headers: { authorization: "Bearer foreign" } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/orders/${e.order.id}/refund-context`, headers: { authorization: "Bearer foreign" } })).statusCode).toBe(404);
    const res = await app.inject({ method: "POST", url: "/v1/relay/refund", payload, headers: { authorization: "Bearer test-key" } });
    expect(res.statusCode).toBe(200);
    await flush();
    expect((await app.inject({ url: `/v1/refunds/${res.json().id}`, headers: { authorization: "Bearer foreign" } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/orders/${e.order.id}/refunds`, headers: { authorization: "Bearer foreign" } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/orders/${e.order.id}/refunds`, headers: { authorization: "Bearer test-key" } })).json().refunds).toHaveLength(1);
  });

  it("checks signer balance before spending gas", async () => {
    const e = await setup(); e.chain.refundBalance = 1n;
    await expect(submit(e, await signed(e))).rejects.toMatchObject({ code: "insufficient_refund_balance" });
    expect(e.chain.refundPrepared).toHaveLength(0);
  });
  it("rejects over-refunds, stale/future indexes, wrong signer, wrong payer and expired windows", async () => {
    const e = await setup();
    await expect(submit(e, await signed(e, { amount: "25000001" }))).rejects.toMatchObject({ code: "amount_mismatch" });
    await expect(submit(e, await signed(e, { refundIndex: 1 }))).rejects.toMatchObject({ code: "already_settled" });
    await expect(submit(e, await signed(e, {}, payer.address, privateKeyToAccount(PAYER_KEY)))).rejects.toMatchObject({ code: "bad_signature" });
    await expect(submit(e, await signed(e, {}, ROUTER))).rejects.toMatchObject({ code: "bad_signature" });
    await expect(submit(e, await signed(e, { validAfter: e.clock.t - 400, validBefore: e.clock.t - 1 }))).rejects.toMatchObject({ code: "bad_signature" });
    expect(e.chain.refundPrepared).toHaveLength(0);
  });
  it("rejects unsettled orders and mismatched on-chain receipts", async () => {
    const e = await setup(); e.db.setStatus(e.order.id, "pending");
    await expect(submit(e, await signed(e))).rejects.toMatchObject({ code: "simulation_failed" });
    e.db.setStatus(e.order.id, "settled");
    e.chain.orderReceipts.set(e.order.id, { payer: ROUTER, value: 25_000_000n, refunded: 0n, refundCount: 0n, settled: true });
    await expect(submit(e, await signed(e))).rejects.toMatchObject({ code: "simulation_failed" });
  });
  it("identical concurrent requests return one refund and hash, and a different pending request is blocked", async () => {
    const e = await setup(); e.chain.receiptFails = true;
    const req = await signed(e);
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(e, req)));
    expect(new Set(results.map(r => r.txHash)).size).toBe(1);
    expect(new Set(results.map(r => r.id)).size).toBe(1);
    expect(e.chain.refundPrepared).toHaveLength(1);
    await expect(submit(e, await signed(e, { amount: "6000000" }))).rejects.toMatchObject({ code: "already_settled" });
    await flush();
  });
  it("retains uncertain broadcasts and recovers using a reopened database", async () => {
    const e = await setup(); e.chain.receiptFails = true; e.chain.broadcastFails = true;
    const r = await submit(e, await signed(e)); await flush();
    const db = new Db(e.db.raw.serialize());
    const svc = new RelayerService({ cfg: e.cfg, db, chain: e.chain, now: () => e.clock.t });
    expect(db.attempts(r.id)[0]?.raw).toBeDefined();
    e.chain.receiptFails = false;
    await svc.refunds.recover(r.id);
    await svc.refunds.recover(r.id);
    expect(svc.refunds.get(MERCHANT_ID, r.id).status).toBe("settled");
    expect(db.dueDeliveries(e.clock.t).filter(d => JSON.parse(d.body).type === "payment.refunded")).toHaveLength(1);
    expect(e.chain.refundPrepared).toHaveLength(1);
    db.close();
  });
  it("shares the payment gas budget and honours pause, simulation failure, price and gas caps", async () => {
    const e = await setup({ lossBudgetWei: 300_000_000_000_000n });
    await expect(submit(e, await signed(e))).rejects.toMatchObject({ code: "relayer_paused" });
    e.cfg.lossBudgetWei = 10n ** 18n; e.svc.setLocalPaused(true);
    await expect(submit(e, await signed(e))).rejects.toMatchObject({ code: "relayer_paused" });
    e.svc.setLocalPaused(false); e.chain.simulateFails = true;
    await expect(submit(e, await signed(e))).rejects.toMatchObject({ code: "simulation_failed" });
    e.chain.simulateFails = false; e.cfg.maxGasLimit = 1n;
    await expect(submit(e, await signed(e))).rejects.toMatchObject({ code: "relayer_paused" });
    e.cfg.maxGasLimit = 500_000n; e.cfg.maxGasPrice = 1n;
    await expect(submit(e, await signed(e))).rejects.toMatchObject({ code: "relayer_paused" });
    expect(e.chain.refundPrepared).toHaveLength(0);
  });
  it("bounds same-nonce refund replacements and continues tracking while paused", async () => {
    const e = await setup({ maxReplacements: 1 }); e.chain.receiptFails = true;
    const r = await submit(e, await signed(e)); await flush();
    e.clock.t += 31;
    await e.svc.refunds.recover(r.id);
    const attempts = e.db.attempts(r.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.nonce).toBe(attempts[1]?.nonce);
    expect(attempts[1]?.gas_price).toBe("1125000000");
    e.clock.t += 31;
    await e.svc.refunds.recover(r.id);
    expect(e.chain.refundPrepared).toHaveLength(2);
    e.svc.setLocalPaused(true); e.chain.receiptFails = false;
    await e.svc.refunds.recover(r.id);
    expect(e.svc.refunds.get(MERCHANT_ID, r.id).status).toBe("settled");
    expect(e.db.spentSince(0)).toBe(300_000_000_000_000n);
  });
  it("a reverted refund leaves the payment paid and allows a fresh signature at the same index", async () => {
    const e = await setup(); e.chain.receiptStatus = "reverted";
    const r = await submit(e, await signed(e)); await flush();
    expect(e.svc.refunds.get(MERCHANT_ID, r.id).status).toBe("failed");
    expect(e.svc.getOrder(e.order.id)).toMatchObject({ status: "settled", refunded: "0" });
    e.chain.receiptStatus = "success";
    await submit(e, await signed(e, { validBefore: e.clock.t + 250 })); await flush();
    expect(e.svc.getOrder(e.order.id).refunded).toBe("5000000");
  });
});
