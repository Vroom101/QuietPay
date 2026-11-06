/**
 * Round-3 hardening: revert throttling and loss-budget share (A), claim ownership (D), crash-safe
 * broadcast (E) and periodic reconciliation (F). In-process FakeChain only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QuietpayError, buildCheckoutAuthorization, type ErrorCode, type Order } from "@quietpay/shared";
import { NonceManager } from "../src/chain.js";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { RelayerService } from "../src/service.js";
import { FakeChain, MERCHANT_ID, makeCfg, makeEnv, newOrder, payer, signFor } from "./helpers.js";

const ctx = { ip: "203.0.113.90" };
const tick = () => new Promise((r) => setTimeout(r, 15));
const HOOK = "https://merchant.example.com/hooks/quietpay";
const KEY_B = ("0x" + "b7".repeat(32)) as Hex;
const KEY_C = ("0x" + "c9".repeat(32)) as Hex;

async function codeOf(p: Promise<unknown>): Promise<ErrorCode | "ok" | "other"> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof QuietpayError ? e.code : "other";
  }
}

async function signAs(key: Hex, order: Order, now: number, validBefore = now + 300) {
  const acct = privateKeyToAccount(key);
  const validAfter = now - 5;
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

function deliveries(db: Db, type: string): number {
  const rows = db.raw.prepare("SELECT body FROM deliveries").all() as { body: string }[];
  return rows.filter((r) => (JSON.parse(r.body) as { type: string }).type === type).length;
}

const baseEnv = {
  RPC_URL: "http://localhost:8545",
  USDT_ADDRESS: "0x" + "11".repeat(20),
  ROUTER_ADDRESS: "0x" + "22".repeat(20),
  RELAYER_PRIVATE_KEY: "0x" + "33".repeat(32),
  OPERATOR_TOKEN: "operator-token-123456",
  MERCHANT_API_KEYS: "k:0x" + "01".repeat(32),
  WEBHOOK_SECRET: "whsec_0123456789abcdef",
};

// ===================================================================== A. zero-cost revert drain
describe("A: short windows, revert throttling and per-payer loss share", () => {
  it("config defaults: 60 s minimum window, 2 reverts/24h, 25% loss share, 30 min tx max age", () => {
    const c = loadConfig(baseEnv);
    expect(c.minValidSeconds).toBe(60);
    expect(c.maxRevertsPerDay).toBe(2);
    expect(c.payerLossSharePercent).toBe(25);
    expect(c.txMaxAgeSeconds).toBe(1800);
    expect(c.reconcileIntervalSeconds).toBe(30);
    expect(loadConfig({ ...baseEnv, MIN_VALID_SECONDS: "90", PAYER_LOSS_SHARE_PERCENT: "10" }).minValidSeconds).toBe(90);
  });

  it("refuses a signed window with less than MIN_VALID_SECONDS left, before anything is claimed or sent", async () => {
    const { svc, chain, db, clock } = makeEnv({ minValidSeconds: 60 });
    const o = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signFor(o, clock.t, { validBefore: clock.t + 2 }), ctx))).toBe("bad_signature");
    expect(await codeOf(svc.relayPay(await signFor(o, clock.t, { validBefore: clock.t + 59 }), ctx))).toBe("bad_signature");
    expect(chain.signed).toHaveLength(0);
    expect(db.getOrder(o.id)!.status).toBe("created");
    expect(await codeOf(svc.relayPay(await signFor(o, clock.t, { validBefore: clock.t + 60 }), ctx))).toBe("ok");
  });

  it("a payer with a recent revert must leave a longer window, and is refused after MAX_REVERTS_PER_DAY reverts", async () => {
    const { svc, chain, db, clock } = makeEnv({ minValidSeconds: 60, revertedPayerMinValidSeconds: 120, maxRevertsPerDay: 2 });
    chain.receiptStatus = "reverted";
    const o1 = await newOrder(svc);
    await svc.relayPay(await signFor(o1, clock.t), ctx);
    await tick();
    expect(db.getOrder(o1.id)!.status).toBe("failed");
    // One revert on record: a 100 s window (fine for a clean payer) is now too short.
    expect(await codeOf(svc.relayPay(await signFor(o1, clock.t, { validBefore: clock.t + 100 }), ctx))).toBe("bad_signature");
    // Long enough: allowed, reverts a second time.
    await svc.relayPay(await signFor(o1, clock.t, { validBefore: clock.t + 280 }), ctx);
    await tick();
    expect(db.getOrder(o1.id)!.status).toBe("failed");
    expect(chain.sent).toHaveLength(2);
    // Two reverts in 24h: the payer is refused for any order, with any window, and nothing is signed.
    chain.receiptStatus = "success";
    const o2 = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signFor(o2, clock.t), ctx))).toBe("rate_limited");
    expect(chain.signed).toHaveLength(2);
    // Rolling: a day later the payer may pay again.
    clock.t += 86_401;
    const o3 = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signFor(o3, clock.t), ctx))).toBe("ok");
  });

  it("an order that reverted MAX_REVERTS_PER_DAY times is refused for every payer (key rotation does not help)", async () => {
    const { svc, chain, clock } = makeEnv({ maxRevertsPerDay: 2 });
    chain.receiptStatus = "reverted";
    const o = await newOrder(svc);
    await svc.relayPay(await signAs(KEY_B, o, clock.t), ctx);
    await tick();
    await svc.relayPay(await signAs(KEY_C, o, clock.t), ctx);
    await tick();
    expect(chain.sent).toHaveLength(2);
    expect(await codeOf(svc.relayPay(await signFor(o, clock.t), ctx))).toBe("rate_limited");
    expect(chain.sent).toHaveLength(2);
  });

  it("one payer's reverts cannot consume more than PAYER_LOSS_SHARE_PERCENT of the hourly loss budget", async () => {
    // Each relay: estimate 150k*1.2*1 gwei = 1.8e14 wei, actual 1.5e14. Budget 1e15, 25% share = 2.5e14.
    const { svc, chain, clock } = makeEnv({ lossBudgetWei: 1_000_000_000_000_000n, maxRevertsPerDay: 100, revertedPayerMinValidSeconds: 0 });
    chain.receiptStatus = "reverted";
    const o1 = await newOrder(svc);
    await svc.relayPay(await signFor(o1, clock.t), ctx);
    await tick();
    const o2 = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signFor(o2, clock.t), ctx))).toBe("rate_limited");
    expect(chain.sent).toHaveLength(1);
    // Everyone else is unaffected: the global budget still has room.
    chain.receiptStatus = "success";
    const o3 = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signAs(KEY_B, o3, clock.t), ctx))).toBe("ok");
    // An hour later the share frees up.
    clock.t += 3601;
    const o4 = await newOrder(svc);
    expect(await codeOf(svc.relayPay(await signFor(o4, clock.t), ctx))).toBe("ok");
  });

  it("successful payments do not count toward the per-payer loss share", async () => {
    const { svc, chain, clock } = makeEnv({ lossBudgetWei: 1_000_000_000_000_000n, payerCap: 10n ** 12n });
    for (let i = 0; i < 4; i++) {
      const o = await newOrder(svc, "1000000");
      expect(await codeOf(svc.relayPay(await signFor(o, clock.t), ctx))).toBe("ok");
      await tick();
    }
    expect(chain.sent).toHaveLength(4);
  });
});

// ===================================================================== B. compare-and-set transitions
describe("B: every status transition is conditional on the expected current state", () => {
  it("an order paid on chain while still `created` here is settled with settled_at and exactly one webhook", async () => {
    const { svc, chain, db, clock } = makeEnv();
    const o = await newOrder(svc, "25000000", { webhookUrl: HOOK });
    chain.settledOnChain = true;
    expect(await codeOf(svc.relayPay(await signFor(o, clock.t), ctx))).toBe("already_settled");
    expect(await codeOf(svc.relayPay(await signFor(o, clock.t), ctx))).toBe("already_settled");
    const row = db.getOrder(o.id)!;
    expect(row.status).toBe("settled");
    expect(row.settled_at).toBe(clock.t);
    expect(deliveries(db, "payment.settled")).toBe(1);
  });

  it("expiry only applies to created/failed orders", () => {
    const { db } = makeEnv();
    db.insertOrder({ id: "0xaa", merchant_id: MERCHANT_ID, amount: "1", fee: "0", payout: "0xp", status: "settled", reference: null, webhook_url: null, nonce: "0xn", payer: null, tx_hash: null, signature: null, valid_after: null, valid_before: null, failure_code: null, created_at: 0, expires_at: 1, settled_at: null, relayed_at: null });
    expect(db.transition("0xaa", ["created", "failed"], "expired")).toBe(false);
    expect(db.getOrder("0xaa")!.status).toBe("settled");
  });
});

// ===================================================================== D. claim ownership
describe("D: claims carry an owner token", () => {
  it("a process whose claim was released as stale (owner presumed dead) cannot broadcast it afterwards", async () => {
    const env = makeEnv();
    const chain = env.chain;
    const p1 = env.svc;
    const p2 = new RelayerService({ cfg: env.cfg, db: env.db, chain, now: () => env.clock.t });
    const order = await newOrder(p1);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const sim = chain.simulatePay.bind(chain);
    let first = true;
    chain.simulatePay = async (a) => {
      if (first) {
        first = false;
        await gate;
      }
      return sim(a);
    };
    const r1 = codeOf(p1.relayPay(await signFor(order, env.clock.t), ctx));
    await tick();
    expect(env.db.getOrder(order.id)!.claim_owner).toBe(p1.owner);
    env.clock.t += 400; // p1 has not heartbeated for longer than OWNER_TIMEOUT_SECONDS: p2 presumes it dead
    p2.heartbeat();
    expect(p2.releaseStaleClaims()).toBe(1);
    const res2 = await p2.relayPay(await signAs(KEY_B, order, env.clock.t), ctx);
    open();
    await r1;
    expect(chain.sent).toHaveLength(1);
    expect(env.db.getOrder(order.id)!.tx_hash).toBe(res2.txHash);
  });
});

// ===================================================================== E. crash-safe broadcast
describe("E: sign, persist, then send", () => {
  it("persists the raw signed tx and its hash on the order before sending", async () => {
    const { svc, chain, db, clock } = makeEnv();
    const o = await newOrder(svc);
    let seen: { tx_hash: string | null; raw_tx: string | null | undefined } | null = null;
    const send = chain.sendRawTx.bind(chain);
    chain.sendRawTx = async (raw) => {
      const r = db.getOrder(o.id)!;
      seen = { tx_hash: r.tx_hash, raw_tx: r.raw_tx };
      return send(raw);
    };
    const res = await svc.relayPay(await signFor(o, clock.t), ctx);
    expect(seen).toEqual({ tx_hash: res.txHash, raw_tx: chain.signed[0]!.raw });
    expect(db.getOrder(o.id)!.tx_nonce).toBe(0);
  });

  it("uncertain broadcast that the node did accept: the hash is found and tracked to settlement", async () => {
    const { svc, chain, db, clock } = makeEnv();
    chain.sendMode = "accept-then-throw";
    const o = await newOrder(svc, "25000000", { webhookUrl: HOOK });
    const res = await svc.relayPay(await signFor(o, clock.t), ctx);
    expect(res.status).toBe("pending");
    expect(res.txHash).toBe(chain.signed[0]!.hash);
    await tick();
    expect(db.getOrder(o.id)!.status).toBe("settled");
    expect(deliveries(db, "payment.settled")).toBe(1);
    expect(chain.signed).toHaveLength(1);
  });

  it("uncertain broadcast the node never saw: broadcast_unknown (public: pending), never released, no second signature", async () => {
    const { svc, chain, db, clock } = makeEnv();
    chain.sendMode = "reject";
    const o = await newOrder(svc);
    const res = await svc.relayPay(await signFor(o, clock.t), ctx);
    expect(res).toMatchObject({ status: "pending", txHash: chain.signed[0]!.hash });
    const row = db.getOrder(o.id)!;
    expect(row.status).toBe("broadcast_unknown");
    expect(row.raw_tx).toBe(chain.signed[0]!.raw);
    expect(svc.getOrder(o.id).status).toBe("pending");
    expect(chain.sendCalls).toBe(2); // the send plus one short retry of the same bytes
    expect(chain.resyncs).toBe(0); // its nonce stays reserved
    // Neither the same payer nor anyone else can get a second tx signed while this one is unresolved.
    chain.sendMode = "ok";
    expect(await codeOf(svc.relayPay(await signFor(o, clock.t, { validBefore: clock.t + 250 }), ctx))).toBe("already_settled");
    expect(await codeOf(svc.relayPay(await signAs(KEY_B, o, clock.t), ctx))).toBe("already_settled");
    clock.t += 10_000;
    expect(svc.releaseStaleClaims()).toBe(0);
    expect(svc.getOrder(o.id).status).toBe("pending");
    expect(chain.signed).toHaveLength(1);
    // The unresolved order still counts toward the payer's cap.
    expect(db.payerVolume(payer.address, clock.t - 86_400)).toBe(25_000_000n);
  });

  it("a retry of the same signature while broadcast_unknown returns the same hash", async () => {
    const { svc, chain, clock } = makeEnv();
    chain.sendMode = "reject";
    const o = await newOrder(svc);
    const req = await signFor(o, clock.t);
    const a = await svc.relayPay(req, ctx);
    const b = await svc.relayPay(req, ctx);
    expect(b).toEqual({ orderId: o.id, status: "pending", txHash: a.txHash });
  });

  it("crash after persist, before send: a fresh process rebroadcasts the persisted bytes at max age and settles once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qp-r3e-"));
    const path = join(dir, "r.db");
    try {
      const clock = { t: 1_800_000_000 };
      const chain = new FakeChain();
      const cfg = makeCfg();
      const db1 = new Db(path);
      const svc1 = new RelayerService({ cfg, db: db1, chain, now: () => clock.t });
      const o = await svc1.createOrder(MERCHANT_ID, { merchantId: MERCHANT_ID, amount: "25000000", webhookUrl: HOOK });
      chain.sendMode = "hang"; // the process dies inside sendRawTransaction
      void svc1.relayPay(await signFor(o, clock.t), ctx);
      await tick();
      expect(chain.sent).toHaveLength(0);
      db1.close();

      chain.sendMode = "ok";
      const db2 = new Db(path);
      const svc2 = new RelayerService({ cfg, db: db2, chain, now: () => clock.t });
      svc2.recoverPending();
      await svc2.reconcile();
      expect(db2.getOrder(o.id)!.status).toBe("pending"); // young: wait, do not touch
      expect(chain.sendCalls).toBe(1);
      clock.t += cfg.txMaxAgeSeconds;
      await svc2.reconcile(); // rebroadcast the persisted raw tx (same hash)
      expect(chain.sent).toHaveLength(1);
      await svc2.reconcile(); // receipt found
      await svc2.reconcile();
      const row = db2.getOrder(o.id)!;
      expect(row.status).toBe("settled");
      expect(row.tx_hash).toBe(chain.signed[0]!.hash);
      expect(deliveries(db2, "payment.settled")).toBe(1);
      expect(chain.signed).toHaveLength(1);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===================================================================== F. reconciliation
describe("F: periodic reconciliation", () => {
  it("settles an order whose tracker gave up (receipt timeout) and never double-settles", async () => {
    const { svc, chain, db, clock } = makeEnv();
    const o = await newOrder(svc, "25000000", { webhookUrl: HOOK });
    chain.holdReceipt = true;
    await svc.relayPay(await signFor(o, clock.t), ctx);
    await svc.reconcile();
    expect(db.getOrder(o.id)!.status).toBe("pending");
    chain.holdReceipt = false; // mined; the live tracker is still waiting
    await svc.reconcile();
    await svc.reconcile();
    expect(db.getOrder(o.id)!.status).toBe("settled");
    expect(db.getOrder(o.id)!.settled_at).toBe(clock.t);
    chain.release();
    await tick();
    expect(deliveries(db, "payment.settled")).toBe(1);
  });

  it("a reverted receipt found by reconciliation fails the order once and counts as a revert", async () => {
    const { svc, chain, db, clock } = makeEnv();
    chain.receiptStatus = "reverted";
    const o = await newOrder(svc, "25000000", { webhookUrl: HOOK });
    chain.holdReceipt = true;
    await svc.relayPay(await signFor(o, clock.t), ctx);
    chain.holdReceipt = false;
    await svc.reconcile();
    chain.release();
    await tick();
    expect(db.getOrder(o.id)!.status).toBe("failed");
    expect(deliveries(db, "payment.failed")).toBe(1);
    expect(db.revertStats(payer.address, clock.t - 86_400).count).toBe(1);
  });

  it("replaced tx: no receipt and the relayer nonce moved past it -> failed (tx_dropped), payment.failed once, retryable", async () => {
    const { svc, chain, db, clock } = makeEnv();
    const o = await newOrder(svc, "25000000", { webhookUrl: HOOK });
    chain.holdReceipt = true;
    const res = await svc.relayPay(await signFor(o, clock.t), ctx);
    chain.holdReceipt = false;
    chain.drop(res.txHash as Hex); // another tx with the same nonce was mined instead
    chain.confirmedNonce = 1;
    await svc.reconcile();
    await svc.reconcile();
    const row = db.getOrder(o.id)!;
    expect(row.status).toBe("failed");
    expect(row.failure_code).toBe("tx_dropped");
    expect(deliveries(db, "payment.failed")).toBe(1);
    expect(chain.resyncs).toBeGreaterThan(0);
    expect(db.spentSince(0)).toBe(0n); // a dropped tx used no gas
    expect(db.payerVolume(payer.address, clock.t - 86_400)).toBe(0n);
    // A dropped tx is not a payer-caused revert, and the order can be paid again.
    expect(db.revertStats(payer.address, clock.t - 86_400).count).toBe(0);
    expect(await codeOf(svc.relayPay(await signFor(o, clock.t, { validBefore: clock.t + 250 }), ctx))).toBe("ok");
  });

  it("dropped tx: no receipt, nonce unused, older than max age -> rebroadcast once, then failed (tx_not_mined)", async () => {
    const { svc, chain, db, clock, cfg } = makeEnv();
    const o = await newOrder(svc, "25000000", { webhookUrl: HOOK });
    chain.holdReceipt = true;
    const res = await svc.relayPay(await signFor(o, clock.t), ctx);
    chain.holdReceipt = false;
    chain.drop(res.txHash as Hex); // evicted from the mempool
    chain.sendMode = "reject"; // and the node refuses it again
    await svc.reconcile();
    expect(db.getOrder(o.id)!.status).toBe("pending"); // young
    clock.t += cfg.txMaxAgeSeconds;
    const callsBefore = chain.sendCalls;
    await svc.reconcile();
    expect(chain.sendCalls).toBe(callsBefore + 1); // exactly one rebroadcast
    expect(db.getOrder(o.id)!.status).toBe("pending");
    await svc.reconcile(); // too soon after the rebroadcast to give up
    expect(chain.sendCalls).toBe(callsBefore + 1);
    clock.t += 600;
    await svc.reconcile();
    await svc.reconcile();
    expect(chain.sendCalls).toBe(callsBefore + 1);
    const row = db.getOrder(o.id)!;
    expect(row.status).toBe("failed");
    expect(row.failure_code).toBe("tx_not_mined");
    expect(deliveries(db, "payment.failed")).toBe(1);
    expect(chain.resyncs).toBeGreaterThan(0); // its nonce is released for reuse
  });

  it("a tx failed as not-mined that lands later is settled after all (once)", async () => {
    const { svc, chain, db, clock, cfg } = makeEnv();
    const o = await newOrder(svc, "25000000", { webhookUrl: HOOK });
    chain.sendMode = "reject";
    const res = await svc.relayPay(await signFor(o, clock.t), ctx);
    clock.t += cfg.txMaxAgeSeconds;
    await svc.reconcile();
    clock.t += 600;
    await svc.reconcile();
    expect(db.getOrder(o.id)!.status).toBe("failed");
    chain.known.add(res.txHash as Hex); // it was in some mempool after all and got mined
    await svc.reconcile();
    await svc.reconcile();
    expect(db.getOrder(o.id)!.status).toBe("settled");
    expect(deliveries(db, "payment.settled")).toBe(1);
  });

  it("broadcast_unknown found later by reconciliation goes back to tracking and settles", async () => {
    const { svc, chain, db, clock } = makeEnv();
    chain.sendMode = "reject";
    const o = await newOrder(svc);
    const res = await svc.relayPay(await signFor(o, clock.t), ctx);
    expect(db.getOrder(o.id)!.status).toBe("broadcast_unknown");
    chain.known.add(res.txHash as Hex); // another RPC backend had it
    await svc.reconcile();
    expect(db.getOrder(o.id)!.status).toBe("settled");
  });

  it("startReconciler runs reconcile periodically on an unref'd timer", async () => {
    const { svc } = makeEnv();
    let n = 0;
    svc.reconcile = async () => {
      n += 1;
      return { settled: 0, failed: 0, rebroadcast: 0 };
    };
    const t = svc.startReconciler(5);
    await new Promise((r) => setTimeout(r, 40));
    clearInterval(t);
    expect(n).toBeGreaterThan(1);
    expect(t.hasRef()).toBe(false);
  });
});

// ===================================================================== NonceManager
describe("NonceManager", () => {
  it("hands out sequential nonces, resyncs after a failed sign and on request", async () => {
    let fetched = 0;
    let pending = 7;
    const m = new NonceManager(async () => {
      fetched += 1;
      return pending;
    });
    expect(await m.run(async (n) => n)).toBe(7);
    expect(await m.run(async (n) => n)).toBe(8);
    await expect(m.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    pending = 9;
    expect(await m.run(async (n) => n)).toBe(9);
    pending = 5;
    m.resync();
    expect(await m.run(async (n) => n)).toBe(5);
    expect(fetched).toBe(3);
  });
});
