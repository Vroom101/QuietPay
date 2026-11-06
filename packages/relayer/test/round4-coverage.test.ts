/**
 * Coverage for the round 4 fixes in service.ts / db.ts / config.ts that had no direct tests:
 *  1. recoverNonceGap, expired-authorization path (zero-value self-transfer fills the hole; cancel re-sent if lost)
 *  2. MAX_NEW_PAYERS_PER_IP_PER_HOUR
 *  3. tx_expired: a revert mined after validBefore with ample headroom is not charged to the payer
 *  4. FIRST_TIME_PAYER_LOSS_SHARE_PERCENT / FIRST_TIME_PAYER_LOSS_CAP_PERCENT boundaries
 *  5. loadConfig lower bound on TX_MAX_AGE_SECONDS (and the new knobs' ranges)
 * Local only: in-process fake chain, no network.
 */
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QuietpayError, buildCheckoutAuthorization, type ErrorCode, type Order } from "@quietpay/shared";
import { CANCEL_GAS, type TxReceipt } from "../src/chain.js";
import { MIN_TX_MAX_AGE_SECONDS, loadConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { EXPIRY_EXEMPT_MIN_HEADROOM_SECONDS, RelayerService, VALID_BEFORE_MARGIN_SECONDS } from "../src/service.js";
import { makeCfg, makeEnv, newOrder, payer, signFor } from "./helpers.js";

const ctx = { ip: "203.0.113.44" };
const tick = () => new Promise((r) => setTimeout(r, 15));
const HOOK = "https://merchant.example.com/hooks/quietpay";
const KEY_A = ("0x" + "a7".repeat(32)) as Hex;
const KEY_B = ("0x" + "b7".repeat(32)) as Hex;
const KEY_D = ("0x" + "d7".repeat(32)) as Hex;
/** A distinct valid private key per index (1-based). */
const keyN = (i: number) => ("0x" + (0x1000 + i).toString(16).padStart(64, "0")) as Hex;

async function codeOf(p: Promise<unknown>): Promise<ErrorCode | "ok" | "other"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof QuietpayError ? e.code : "other";
  }
}

async function signAs(key: Hex, order: Order, now: number, windowSeconds = 300) {
  const acct = privateKeyToAccount(key);
  const validAfter = now - 5;
  const validBefore = now + windowSeconds;
  const signature = await acct.signTypedData(
    buildCheckoutAuthorization({
      from: acct.address,
      router: order.checkout.router as Hex,
      value: BigInt(order.amount),
      nonce: order.checkout.nonce as Hex,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      chainId: order.checkout.chainId,
      token: order.checkout.token as Hex,
    }),
  );
  return { orderId: order.id, payer: acct.address, validAfter, validBefore, signature };
}

function webhooks(db: Db, type: string): { data: { failureCode?: string } }[] {
  const rows = db.raw.prepare("SELECT body FROM deliveries").all() as { body: string }[];
  return rows.map((r) => JSON.parse(r.body)).filter((b: { type: string }) => b.type === type);
}

function spendOf(db: Db, hash: string): bigint | null {
  const r = db.raw.prepare("SELECT wei FROM spend WHERE tx_hash=?").get(hash) as { wei: string } | undefined;
  return r ? BigInt(r.wei) : null;
}

/** Wraps sendRawTx to log every raw tx handed to the node, with the (fake) time it was sent. */
function logSends(env: ReturnType<typeof makeEnv>) {
  const sends: { raw: Hex; t: number }[] = [];
  const orig = env.chain.sendRawTx.bind(env.chain);
  env.chain.sendRawTx = async (raw: Hex) => {
    sends.push({ raw, t: env.clock.t });
    return orig(raw);
  };
  return sends;
}

/**
 * Order A's pay tx never reaches the node (both sends fail at the transport): broadcast_unknown at nonce 0.
 * Order B is sent fine at nonce 1 and queues behind the hole. Receipts are held (nothing is mined yet).
 */
async function holeWithQueuedTx(withQueued = true) {
  const env = makeEnv({ minValidSeconds: 60 });
  const sends = logSends(env);
  const { svc, chain, db, clock } = env;
  const oA = await newOrder(svc, "25000000", { webhookUrl: HOOK });
  chain.sendMode = "reject";
  const sigA = await signAs(KEY_A, oA, clock.t);
  expect((await svc.relayPay(sigA, ctx)).status).toBe("pending");
  const rowA = db.getOrder(oA.id)!;
  expect(rowA.status).toBe("broadcast_unknown");
  expect(rowA.tx_nonce).toBe(0);
  chain.sendMode = "ok";
  chain.holdReceipt = true;
  let oB: Order | null = null;
  if (withQueued) {
    oB = await newOrder(svc);
    await svc.relayPay(await signAs(KEY_B, oB, clock.t), ctx);
    expect(db.getOrder(oB.id)!.tx_nonce).toBe(1);
    expect(db.getOrder(oB.id)!.status).toBe("pending");
  }
  return { ...env, sends, oA, sigA, rawA: rowA.raw_tx as Hex, hashA: rowA.tx_hash as Hex, oB };
}

// ===================================================================== 1. nonce gap, expired authorization
describe("round 4: recoverNonceGap fills an expired hole with a self-transfer", () => {
  it("fills the gap with a zero-value self-transfer at a bumped gas price, never re-sends the pay tx, and ends tx_not_sent with no revert charged", async () => {
    const env = await holeWithQueuedTx();
    const { svc, chain, db, clock, sends, oA, sigA, rawA, hashA, oB } = env;
    const payerA = privateKeyToAccount(KEY_A).address;

    // The reconciler only gets to run after A's authorization has expired (plus the margin).
    clock.t = sigA.validBefore + VALID_BEFORE_MARGIN_SECONDS;
    await svc.reconcile();

    expect(chain.cancels).toHaveLength(1);
    const cancel = chain.cancels[0]!;
    expect(cancel.nonce).toBe(0);
    // prev gas price 1 gwei: bumped by 15% + 1 wei so it can replace a copy of the pay tx some node still holds.
    expect(cancel.gasPrice).toBe((1_000_000_000n * 115n) / 100n + 1n);
    expect(chain.known.has(cancel.hash)).toBe(true);
    const a1 = db.getOrder(oA.id)!;
    expect(a1.cancel_hash).toBe(cancel.hash);
    expect(a1.cancel_code).toBe("tx_not_sent");
    expect(a1.status).toBe("broadcast_unknown");
    expect(spendOf(db, cancel.hash)).toBe(CANCEL_GAS * cancel.gasPrice);
    expect(db.getAttempt(cancel.hash)?.kind).toBe("cancel");

    // A second pass while the cancel is pending neither signs another cancel nor re-sends anything.
    const before = sends.length;
    clock.t += 30;
    await svc.reconcile();
    expect(chain.cancels).toHaveLength(1);
    expect(sends.length).toBe(before);

    // The self-transfer is mined: nonce 0 is consumed.
    chain.confirmedNonce = 1;
    clock.t += 30;
    await svc.reconcile();
    const a2 = db.getOrder(oA.id)!;
    expect(a2.status).toBe("failed");
    expect(a2.failure_code).toBe("tx_not_sent");
    expect(spendOf(db, hashA)).toBe(0n); // the pay tx itself burnt nothing
    expect(db.revertStats(payerA, 0).count).toBe(0);
    expect(db.orderRevertCount(oA.id, 0)).toBe(0);
    const failed = webhooks(db, "payment.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data.failureCode).toBe("tx_not_sent");

    // The queued tx behind the hole is mined and settles.
    chain.holdReceipt = false;
    chain.confirmedNonce = 2;
    clock.t += 30;
    await svc.reconcile();
    expect(db.getOrder(oB!.id)!.status).toBe("settled");
    expect(db.getOrder(oA.id)!.status).toBe("failed"); // late check found no receipt for A's never-sent tx

    // The reverting pay tx was never handed to the node after its authorization expired, and never accepted.
    expect(sends.filter((s) => s.raw === rawA && s.t >= sigA.validBefore)).toHaveLength(0);
    expect(chain.sent.map((a) => a.orderId.toLowerCase())).not.toContain(oA.id.toLowerCase());
  });

  it("re-sends the same cancel bytes when the node loses it (and when its first send failed), without signing a second one", async () => {
    const env = await holeWithQueuedTx();
    const { svc, chain, db, clock, sends, oA, sigA } = env;

    // The first send of the cancel fails at the transport.
    chain.sendMode = "reject";
    clock.t = sigA.validBefore + VALID_BEFORE_MARGIN_SECONDS;
    await svc.reconcile();
    expect(chain.cancels).toHaveLength(1);
    const cancel = chain.cancels[0]!;
    expect(db.getOrder(oA.id)!.cancel_hash).toBe(cancel.hash);
    expect(chain.known.has(cancel.hash)).toBe(false);

    // Next pass: the node does not have it, so the persisted bytes are sent again.
    chain.sendMode = "ok";
    clock.t += 30;
    await svc.reconcile();
    expect(chain.known.has(cancel.hash)).toBe(true);

    // The node evicts it: re-sent again on the next pass.
    chain.drop(cancel.hash);
    clock.t += 30;
    await svc.reconcile();
    expect(chain.known.has(cancel.hash)).toBe(true);
    expect(chain.cancels).toHaveLength(1);
    expect(sends.filter((s) => s.raw === cancel.raw)).toHaveLength(3);
    expect(db.getOrder(oA.id)!.status).toBe("broadcast_unknown");

    chain.confirmedNonce = 1;
    clock.t += 30;
    await svc.reconcile();
    expect(db.getOrder(oA.id)!.failure_code).toBe("tx_not_sent");
    expect(db.revertStats(privateKeyToAccount(KEY_A).address, 0).count).toBe(0);
  });

  it("does not fill the gap before validBefore + margin (the tx may still be mining) and never re-sends the expired pay tx meanwhile", async () => {
    const { svc, chain, clock, sends, rawA, sigA } = await holeWithQueuedTx();
    clock.t = sigA.validBefore; // expired, but inside the margin
    await svc.reconcile();
    clock.t = sigA.validBefore + VALID_BEFORE_MARGIN_SECONDS - 1;
    await svc.reconcile();
    expect(chain.cancels).toHaveLength(0);
    expect(sends.filter((s) => s.raw === rawA && s.t >= sigA.validBefore)).toHaveLength(0);
  });

  it("does not fill the gap when nothing is queued behind it, or when the hole is not the relayer's next nonce", async () => {
    // Nothing queued: no cancel (the max-age path handles it).
    const lone = await holeWithQueuedTx(false);
    lone.clock.t = lone.sigA.validBefore + VALID_BEFORE_MARGIN_SECONDS;
    await lone.svc.reconcile();
    expect(lone.chain.cancels).toHaveLength(0);

    // The confirmed nonce is below the hole (an earlier tx is still unmined): not this order's gap to fill.
    const q = await holeWithQueuedTx();
    q.db.raw.prepare("UPDATE orders SET tx_nonce=5 WHERE id=?").run(q.oA.id.toLowerCase());
    q.db.raw.prepare("UPDATE orders SET tx_nonce=6 WHERE id=?").run(q.oB!.id.toLowerCase());
    q.clock.t = q.sigA.validBefore + VALID_BEFORE_MARGIN_SECONDS;
    await q.svc.reconcile();
    expect(q.chain.cancels).toHaveLength(0);
  });

  it("refuses to fill the gap above MAX_GAS_PRICE (the bumped price counts)", async () => {
    const env = await holeWithQueuedTx();
    // 1.1 gwei cap: the relay at 1 gwei passed, the 1.15 gwei bump does not.
    (env.svc.cfg as { maxGasPrice: bigint | null }).maxGasPrice = 1_100_000_000n;
    env.clock.t = env.sigA.validBefore + VALID_BEFORE_MARGIN_SECONDS;
    await env.svc.reconcile();
    expect(env.chain.cancels).toHaveLength(0);
    expect(env.db.getOrder(env.oA.id)!.cancel_hash ?? null).toBeNull();
  });
});

// ===================================================================== 2. new payers per IP
describe("round 4: MAX_NEW_PAYERS_PER_IP_PER_HOUR", () => {
  const IP1 = "198.51.100.1";
  const IP2 = "198.51.100.2";

  it("refuses an 11th new payer from one IP within an hour; known and settled payers and other IPs are unaffected", async () => {
    const { svc, chain, db, clock } = makeEnv();

    // A repeat payer: settled once (from another IP so it does not use IP1's quota).
    const o0 = await newOrder(svc);
    await svc.relayPay(await signFor(o0, clock.t), { ip: "192.0.2.9" });
    await tick();
    expect(db.getOrder(o0.id)!.status).toBe("settled");

    chain.holdReceipt = true; // the new payers stay first-time (nothing settles)
    for (let i = 1; i <= 10; i++) {
      const o = await newOrder(svc);
      expect(await codeOf(svc.relayPay(await signAs(keyN(i), o, clock.t), { ip: IP1 }))).toBe("ok");
    }

    const o11 = await newOrder(svc);
    await expect(svc.relayPay(await signAs(keyN(11), o11, clock.t), { ip: IP1 })).rejects.toThrow(/new wallets from this connection/);
    expect(await codeOf(svc.relayPay(await signAs(keyN(11), o11, clock.t), { ip: IP1 }))).toBe("rate_limited");
    expect(db.getOrder(o11.id)!.status).toBe("created"); // refused before anything was claimed
    expect(chain.sent).toHaveLength(11);

    // A payer with a settled order is not a new payer.
    const oS = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signFor(oS, clock.t), { ip: IP1 }))).toBe("ok");
    // A new payer already counted for IP1 this hour may pay again.
    const oK = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signAs(keyN(1), oK, clock.t), { ip: IP1 }))).toBe("ok");
    // The counter is per IP: the same 11th key is fine from another IP.
    expect(await codeOf(svc.relayPay(await signAs(keyN(11), o11, clock.t), { ip: IP2 }))).toBe("ok");

    // An hour later IP1's slots are free again.
    clock.t += 3601;
    const o12 = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signAs(keyN(12), o12, clock.t), { ip: IP1 }))).toBe("ok");
  });

  it("only a relay that was actually sent uses a slot (rejected attempts do not count)", async () => {
    const { svc, chain, clock } = makeEnv({ maxNewPayersPerIpPerHour: 2 });
    chain.holdReceipt = true;
    chain.simulateFails = true;
    for (let i = 1; i <= 5; i++) {
      const o = await newOrder(svc);
      expect(await codeOf(svc.relayPay(await signAs(keyN(i), o, clock.t), { ip: IP1 }))).toBe("simulation_failed");
    }
    chain.simulateFails = false;
    for (let i = 6; i <= 7; i++) {
      const o = await newOrder(svc);
      expect(await codeOf(svc.relayPay(await signAs(keyN(i), o, clock.t), { ip: IP1 }))).toBe("ok");
    }
    const o = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signAs(keyN(8), o, clock.t), { ip: IP1 }))).toBe("rate_limited");
  });
});

// ===================================================================== 3. tx_expired
describe("round 4: tx_expired (mined after validBefore, relayer's delay) is not charged to the payer", () => {
  /** Relays one order with the given window, holds the receipt, then mines it as a revert `blockOffset` s after validBefore. */
  async function revertMined(opts: { window: number; blockOffset: number; minValidSeconds?: number; withTimestamp?: boolean }) {
    const env = makeEnv({ minValidSeconds: opts.minValidSeconds ?? 0 });
    const { svc, chain, clock } = env;
    const o = await newOrder(svc, "25000000", { webhookUrl: HOOK });
    chain.holdReceipt = true;
    const sig = await signFor(o, clock.t, { validBefore: clock.t + opts.window });
    const r = await svc.relayPay(sig, ctx);
    const blockTs = sig.validBefore + opts.blockOffset;
    const receipt: TxReceipt = { status: "reverted", gasUsed: 40_000n, effectiveGasPrice: 1_000_000_000n, blockNumber: 7n };
    if (opts.withTimestamp !== false) receipt.blockTimestamp = BigInt(blockTs);
    chain.receipts.set(r.txHash as Hex, receipt);
    chain.holdReceipt = false;
    clock.t = Math.max(clock.t, blockTs) + 5;
    return { ...env, o, sig };
  }

  it("a revert mined after the deadline with >= 60 s headroom at signing is tx_expired, no revert recorded", async () => {
    const { svc, db, o } = await revertMined({ window: 300, blockOffset: 3 });
    await svc.reconcile();
    const row = db.getOrder(o.id)!;
    expect(row.status).toBe("failed");
    expect(row.failure_code).toBe("tx_expired");
    expect(db.revertStats(payer.address, 0).count).toBe(0);
    expect(db.orderRevertCount(o.id, 0)).toBe(0);
    expect(webhooks(db, "payment.failed")[0]!.data.failureCode).toBe("tx_expired");
  });

  it("boundary: exactly EXPIRY_EXEMPT_MIN_HEADROOM_SECONDS of headroom is exempt, one second less is charged", async () => {
    expect(EXPIRY_EXEMPT_MIN_HEADROOM_SECONDS).toBe(60);
    const ok = await revertMined({ window: 60, blockOffset: 0 }); // mined exactly at validBefore (router: Expired)
    await ok.svc.reconcile();
    expect(ok.db.getOrder(ok.o.id)!.failure_code).toBe("tx_expired");
    expect(ok.db.revertStats(payer.address, 0).count).toBe(0);

    const short = await revertMined({ window: 59, blockOffset: 0 });
    await short.svc.reconcile();
    expect(short.db.getOrder(short.o.id)!.failure_code).toBe("simulation_failed");
    expect(short.db.revertStats(payer.address, 0).count).toBe(1);
  });

  it("a payer who signed a ~2 s window is still charged the revert", async () => {
    const { svc, db, o } = await revertMined({ window: 2, blockOffset: 1 });
    await svc.reconcile();
    expect(db.getOrder(o.id)!.failure_code).toBe("simulation_failed");
    const s = db.revertStats(payer.address, 0);
    expect(s.count).toBe(1);
    expect(s.wei).toBe(40_000n * 1_000_000_000n);
  });

  it("a revert mined before the deadline, or with no block timestamp, is charged whatever the headroom", async () => {
    const early = await revertMined({ window: 300, blockOffset: -100 });
    await early.svc.reconcile();
    expect(early.db.getOrder(early.o.id)!.failure_code).toBe("simulation_failed");
    expect(early.db.revertStats(payer.address, 0).count).toBe(1);

    const noTs = await revertMined({ window: 300, blockOffset: 10, withTimestamp: false });
    await noTs.svc.reconcile();
    expect(noTs.db.getOrder(noTs.o.id)!.failure_code).toBe("simulation_failed");
    expect(noTs.db.revertStats(payer.address, 0).count).toBe(1);
  });

  it("the exemption threshold is MIN_VALID_SECONDS when that is larger than 60 s", async () => {
    // Relayed under MIN_VALID_SECONDS=0 with 75 s headroom; the receipt is applied after a restart with MIN_VALID_SECONDS=90.
    const env = await revertMined({ window: 75, blockOffset: 2 });
    const svc90 = new RelayerService({ cfg: makeCfg({ minValidSeconds: 90 }), db: env.db, chain: env.chain, now: () => env.clock.t, broadcastRetryMs: 0 });
    await svc90.reconcile();
    expect(env.db.getOrder(env.o.id)!.failure_code).toBe("simulation_failed");
    expect(env.db.revertStats(payer.address, 0).count).toBe(1);

    const env2 = await revertMined({ window: 90, blockOffset: 2 });
    const svc90b = new RelayerService({ cfg: makeCfg({ minValidSeconds: 90 }), db: env2.db, chain: env2.chain, now: () => env2.clock.t, broadcastRetryMs: 0 });
    await svc90b.reconcile();
    expect(env2.db.getOrder(env2.o.id)!.failure_code).toBe("tx_expired");
    expect(env2.db.revertStats(payer.address, 0).count).toBe(0);
  });

  it("a tx_expired order does not put the payer under the reverted-payer rules", async () => {
    const { svc, db, clock, o } = await revertMined({ window: 300, blockOffset: 3 });
    await svc.reconcile();
    expect(db.getOrder(o.id)!.failure_code).toBe("tx_expired");
    // A reverted payer must leave REVERTED_PAYER_MIN_VALID_SECONDS (120); this one is not one, so 100 s is fine.
    const o2 = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signFor(o2, clock.t, { validBefore: clock.t + 100 }), ctx))).toBe("ok");
  });
});

// ===================================================================== 4. first-time payer loss share / cap
describe("round 4: FIRST_TIME_PAYER_LOSS_SHARE_PERCENT and FIRST_TIME_PAYER_LOSS_CAP_PERCENT", () => {
  const BUDGET = 50_000_000_000_000_000n; // 0.05 WBT (helpers default)
  const attacker = privateKeyToAccount(KEY_D).address;
  let seq = 0;
  /** Seeds a revert by a first-time payer (and, unless `spend` is false, its gas in the shared budget). */
  function seedFirstTimeRevert(db: Db, ts: number, wei: bigint, spend = true) {
    const h = "0x" + (++seq).toString(16).padStart(64, "e");
    db.recordRevert({ txHash: h, orderId: "0x" + "ab".repeat(32), payer: attacker, ts, wei, firstTime: true });
    if (spend) db.recordSpend(h, ts, wei);
  }
  const fill = (db: Db, ts: number, wei: bigint) => db.recordSpend("0x" + (++seq).toString(16).padStart(64, "f"), ts, wei);

  async function settledRepeatPayer(env: ReturnType<typeof makeEnv>) {
    const o = await newOrder(env.svc);
    await env.svc.relayPay(await signFor(o, env.clock.t), ctx);
    await tick();
    expect(env.db.getOrder(o.id)!.status).toBe("settled");
  }

  // ---- cap (4d): first-time payers refused once their reverts reach CAP% of the budget
  it("cap boundary: first-time losses one wei under the cap pass, at the cap first-time payers are refused but repeat payers are not", async () => {
    const under = makeEnv({ firstTimePayerLossCapPercent: 100 });
    seedFirstTimeRevert(under.db, under.clock.t, BUDGET - 1n, false);
    const o1 = await newOrder(under.svc);
    expect(await codeOf(under.svc.relayPay(await signAs(KEY_A, o1, under.clock.t), ctx))).toBe("ok");

    const at = makeEnv({ firstTimePayerLossCapPercent: 100 });
    await settledRepeatPayer(at);
    seedFirstTimeRevert(at.db, at.clock.t, BUDGET, false);
    const o2 = await newOrder(at.svc);
    await expect(at.svc.relayPay(await signAs(KEY_A, o2, at.clock.t), ctx)).rejects.toThrow(/new wallets right now/);
    const o3 = await newOrder(at.svc);
    expect(await codeOf(at.svc.relayPay(await signFor(o3, at.clock.t), ctx))).toBe("ok");
  });

  it("cap 0%: no first-time losses yet still lets first-time payers through; one wei of loss closes it", async () => {
    const env = makeEnv({ firstTimePayerLossCapPercent: 0 });
    const o1 = await newOrder(env.svc);
    expect(await codeOf(env.svc.relayPay(await signAs(KEY_A, o1, env.clock.t), ctx))).toBe("ok");
    seedFirstTimeRevert(env.db, env.clock.t, 1n, false);
    const o2 = await newOrder(env.svc);
    expect(await codeOf(env.svc.relayPay(await signAs(KEY_B, o2, env.clock.t), ctx))).toBe("rate_limited");
  });

  it("cap is a rolling hour: first-time losses older than an hour do not count", async () => {
    const env = makeEnv({ firstTimePayerLossCapPercent: 100 });
    seedFirstTimeRevert(env.db, env.clock.t - 3601, BUDGET * 2n, false);
    const o = await newOrder(env.svc);
    expect(await codeOf(env.svc.relayPay(await signAs(KEY_A, o, env.clock.t), ctx))).toBe("ok");
  });

  it("recordRevert classifies the payer: a payer with a settled order is not first-time", async () => {
    const env = makeEnv();
    await settledRepeatPayer(env);
    env.db.recordRevert({ txHash: "0x" + "c1".repeat(32), orderId: "0x" + "ab".repeat(32), payer: payer.address, ts: env.clock.t, wei: 1000n });
    env.db.recordRevert({ txHash: "0x" + "c2".repeat(32), orderId: "0x" + "ab".repeat(32), payer: attacker, ts: env.clock.t, wei: 7n });
    expect(env.db.firstTimeRevertWei(env.clock.t - 3600)).toBe(7n);
  });

  // ---- share (11): first-time losses count toward the shared budget only up to SHARE%
  /** Returns the relay outcome for a repeat payer with the shared budget filled so the request lands exactly on it (+extra). */
  async function sharedBudgetCase(opts: { sharePercent: number; ftLoss: bigint; extra: bigint }) {
    const env = makeEnv({ firstTimePayerLossSharePercent: opts.sharePercent, firstTimePayerLossCapPercent: 1000 });
    await settledRepeatPayer(env);
    const { svc, chain, db, clock } = env;
    const now = clock.t;
    const estimate = ((chain.gas * 12n) / 10n) * chain.gasPrice;
    const ftShare5 = (BUDGET * 5n) / 100n;
    const base = db.spentSince(now - 3600);
    seedFirstTimeRevert(db, now, opts.ftLoss);
    // Other (non-first-time) spend so that base + fill + 5% share + estimate == budget (+extra).
    fill(db, now, BUDGET - base - ftShare5 - estimate + opts.extra);
    const o = await newOrder(svc);
    return codeOf(svc.relayPay(await signFor(o, clock.t), ctx));
  }

  it("share boundary: first-time losses above SHARE% are not counted, so landing exactly on the budget passes and one wei over pauses", async () => {
    expect(await sharedBudgetCase({ sharePercent: 5, ftLoss: 20_000_000_000_000_000n, extra: 0n })).toBe("ok");
    expect(await sharedBudgetCase({ sharePercent: 5, ftLoss: 20_000_000_000_000_000n, extra: 1n })).toBe("relayer_paused");
    // However large the first-time losses, only the share counts.
    expect(await sharedBudgetCase({ sharePercent: 5, ftLoss: 45_000_000_000_000_000n, extra: 0n })).toBe("ok");
    // First-time losses exactly at the share: no excess, counted in full.
    expect(await sharedBudgetCase({ sharePercent: 5, ftLoss: (BUDGET * 5n) / 100n, extra: 0n })).toBe("ok");
    expect(await sharedBudgetCase({ sharePercent: 5, ftLoss: (BUDGET * 5n) / 100n, extra: 1n })).toBe("relayer_paused");
  });

  it("share 100%: first-time losses count in full toward the shared budget (control)", async () => {
    expect(await sharedBudgetCase({ sharePercent: 100, ftLoss: 20_000_000_000_000_000n, extra: 0n })).toBe("relayer_paused");
  });
});

// ===================================================================== 5. config
describe("round 4: loadConfig", () => {
  const baseEnv = {
    RPC_URL: "http://localhost:8545",
    USDT_ADDRESS: "0x" + "11".repeat(20),
    ROUTER_ADDRESS: "0x" + "22".repeat(20),
    RELAYER_PRIVATE_KEY: "0x" + "33".repeat(32),
    OPERATOR_TOKEN: "operator-token-123456",
    MERCHANT_API_KEYS: "k:0x" + "01".repeat(32),
    WEBHOOK_SECRET: "whsec_0123456789abcdef",
  };

  it("refuses TX_MAX_AGE_SECONDS below 600 and accepts 600", () => {
    expect(MIN_TX_MAX_AGE_SECONDS).toBe(600);
    expect(() => loadConfig({ ...baseEnv, TX_MAX_AGE_SECONDS: "599" })).toThrow(/TX_MAX_AGE_SECONDS must be at least 600/);
    expect(() => loadConfig({ ...baseEnv, TX_MAX_AGE_SECONDS: "60" })).toThrow(/at least 600/);
    expect(loadConfig({ ...baseEnv, TX_MAX_AGE_SECONDS: "600" }).txMaxAgeSeconds).toBe(600);
  });

  it("first-time payer and new-payer knobs: defaults and ranges", () => {
    const c = loadConfig(baseEnv);
    expect(c.firstTimePayerLossSharePercent).toBe(5);
    expect(c.firstTimePayerLossCapPercent).toBe(100);
    expect(c.maxNewPayersPerIpPerHour).toBe(10);
    expect(loadConfig({ ...baseEnv, FIRST_TIME_PAYER_LOSS_SHARE_PERCENT: "0" }).firstTimePayerLossSharePercent).toBe(0);
    expect(() => loadConfig({ ...baseEnv, FIRST_TIME_PAYER_LOSS_SHARE_PERCENT: "101" })).toThrow();
    expect(loadConfig({ ...baseEnv, FIRST_TIME_PAYER_LOSS_CAP_PERCENT: "1000" }).firstTimePayerLossCapPercent).toBe(1000);
    expect(() => loadConfig({ ...baseEnv, FIRST_TIME_PAYER_LOSS_CAP_PERCENT: "1001" })).toThrow();
    expect(() => loadConfig({ ...baseEnv, MAX_NEW_PAYERS_PER_IP_PER_HOUR: "0" })).toThrow();
  });
});
