import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { WebhookVerificationError, verifyWebhook, createOrder } from "@quietpay/merchant-sdk";
import {
  chainEventCount, codeOf, doRefund, errCode, get, newOrder, nonceUsed, payOrder, post, postRefund, read, refundNonceUsed, relayPay,
  signedRefundBody, signPay, verifyHit, waitRefund, waitStatus, listRefunds, getRefundContext,
} from "./actions.js";
import type { Stack } from "./stack.js";
import { log, sleep, waitUntil } from "./util.js";
import { runIndexVerify } from "./verify-flow.js";

const USDT = (n: number) => BigInt(Math.round(n * 1e6));

export interface Evidence { txs: { label: string; hash: string }[]; notes: string[] }
export const newEvidence = (): Evidence => ({ txs: [], notes: [] });

export interface Scenario {
  id: string;
  title: string;
  given: string;
  when: string;
  then: string;
  /** Needs the owner/proxy/anvil controls (local stack only). */
  localOnly?: boolean;
  run(s: Stack, ev: Evidence): Promise<void>;
}

const nonceCount = (s: Stack) => s.pub.getTransactionCount({ address: s.relayerAddress });
const hitsFor = (s: Stack, orderId: string, type?: string) =>
  s.sink.hits.filter((h) => {
    try { const e = JSON.parse(h.body); return e.data.orderId.toLowerCase() === orderId.toLowerCase() && (!type || e.type === type); } catch { return false; }
  });
const relayerWbt = (s: Stack) => s.wbtOf(s.relayerAddress);

// ---------------------------------------------------------------------------------------------------- scenarios

export const scenarios: Scenario[] = [
  {
    id: "S1", title: "A payer with zero WBT pays and the order settles with the fee as signed",
    given: "a payer holding USDT and exactly zero WBT, and a 25 USDT order created by the merchant SDK",
    when: "the payer signs once and the relayer submits the payment",
    then: "the order settles; payout gets amount minus the signed fee, the relayer gets the fee, the payer's WBT is still zero",
    async run(s, ev) {
      const p = await s.newPayer(USDT(100));
      assert.equal(await s.wbtOf(p.address), 0n);
      const relayerUsdt0 = await s.usdtOf(s.relayerAddress), payout0 = await s.usdtOf(s.tenant.payout);
      const { order, settled, txHash } = await payOrder(s, USDT(25), p.key, { hook: false });
      ev.txs.push({ label: "S1 pay", hash: txHash });
      assert.equal(order.fee, "50000");
      assert.equal(settled.txHash?.toLowerCase(), txHash.toLowerCase());
      assert.equal(await s.usdtOf(p.address), USDT(100) - USDT(25));
      assert.equal((await s.usdtOf(s.tenant.payout)) - payout0, USDT(25) - 50_000n);
      assert.equal((await s.usdtOf(s.relayerAddress)) - relayerUsdt0, 50_000n);
      assert.equal(await s.wbtOf(p.address), 0n, "payer WBT must be unchanged");
      assert.equal(await nonceUsed(s, p.address, order), true);
    },
  },
  {
    id: "S2", title: "The merchant webhook sink receives payment.settled with a valid signature the SDK verifies",
    given: "an order with a webhookUrl pointing at the merchant's sink",
    when: "the payment settles",
    then: "exactly one signed payment.settled arrives and verifyWebhook accepts it with the merchant's derived secret",
    async run(s) {
      const p = await s.newPayer(USDT(50));
      const { order, txHash } = await payOrder(s, USDT(5), p.key);
      const hit = await waitUntil(() => hitsFor(s, order.id, "payment.settled").find((h) => h.status === 200), "settled webhook", 30_000);
      const ev = verifyHit(s, s.tenant, hit);
      assert.equal(ev.type, "payment.settled");
      assert.equal(ev.data.txHash?.toLowerCase(), txHash.toLowerCase());
      assert.equal(ev.data.amount, order.amount);
      assert.equal(ev.data.fee, order.fee);
      assert.equal(hitsFor(s, order.id, "payment.settled").filter((h) => h.status === 200).length, 1);
    },
  },
  {
    id: "S3", title: "Partial refund, second partial refund, then the remainder; a refund above the remainder is refused",
    given: "a settled 10 USDT order and a funded merchant refund signer",
    when: "the merchant refunds 3, then 2, tries 6 (more than the 5 left), then refunds the remaining 5 via the SDK",
    then: "the first, second and remaining refunds settle, the over-refund is refused, the order ends refunded and the payer is whole",
    async run(s, ev) {
      const p = await s.newPayer(USDT(100));
      const { order } = await payOrder(s, USDT(10), p.key, { hook: false });
      const id = order.id as Hex;
      const r0 = await doRefund(s, id, 0, USDT(3));
      const r1 = await doRefund(s, id, 1, USDT(2));
      ev.txs.push({ label: "S3 refund #0 (3 USDT)", hash: r0.txHash! }, { label: "S3 refund #1 (2 USDT)", hash: r1.txHash! });
      assert.equal((await read(s, id)).status, "partially_refunded");
      // more than the remainder: refused by the relayer (signed correctly so only the amount rule can stop it)
      const over = await postRefund(s, await signedRefundBody(s, id, USDT(6), 2, s.tenant.refundKey));
      assert.ok(over.status >= 400 && over.status < 500, `over-refund answered ${over.status}`);
      assert.equal(errCode(over), "amount_mismatch");
      // the SDK refuses it locally too
      assert.match((await codeOf(doRefund(s, id, 2, USDT(6))))!, /Invalid refund amount/);
      const r2 = await doRefund(s, id, 2); // remaining = 5
      ev.txs.push({ label: "S3 refund #2 (remaining 5 USDT)", hash: r2.txHash! });
      assert.equal(r2.amount, USDT(5).toString());
      assert.equal((await waitStatus(s, id, ["refunded"])).status, "refunded");
      assert.equal(await s.usdtOf(p.address), USDT(100));
      assert.equal(await chainEventCount(s, id, "Refunded"), 3);
      // nothing left to refund
      assert.match((await codeOf(doRefund(s, id, 3, 1n)))!, /Invalid refund amount/);
      assert.equal(await refundNonceUsed(s, id, p.address as Address, USDT(3), 0), true);
    },
  },
  {
    id: "S4", title: "Five concurrent /v1/relay/pay calls for one order produce one transaction",
    given: "one order and one signed authorization",
    when: "five identical relay calls are fired at the same time",
    then: "no call fails with a server error, every success carries the same hash, and the chain shows one Paid event and one relayer transaction",
    async run(s, ev) {
      const p = await s.newPayer(USDT(50));
      const order = await newOrder(s, USDT(4), { hook: false });
      const sig = await signPay(order, p.key);
      const n0 = await nonceCount(s);
      const rs = await Promise.all(Array.from({ length: 5 }, () => relayPay(s, sig)));
      assert.ok(rs.every((r) => r.status < 500), JSON.stringify(rs.map((r) => r.status)));
      const hashes = new Set(rs.filter((r) => r.status === 200).map((r) => r.json.txHash));
      assert.equal(hashes.size, 1, `distinct hashes: ${[...hashes]}`);
      const settled = await waitStatus(s, order.id as Hex, ["settled"]);
      ev.txs.push({ label: "S4 pay (5 concurrent calls)", hash: settled.txHash! });
      assert.equal((await nonceCount(s)) - n0, 1, "exactly one relayer transaction");
      assert.equal(await chainEventCount(s, order.id as Hex, "Paid"), 1);
    },
  },
  {
    id: "S5", title: "A duplicate refund POST produces one refund",
    given: "a settled order and one correctly signed refund request",
    when: "the same body is POSTed twice at once and once more afterwards",
    then: "one refund exists, one Refunded event is on chain, and the repeats are answered with the same refund or a clean 4xx",
    async run(s, ev) {
      const p = await s.newPayer(USDT(50));
      const { order } = await payOrder(s, USDT(6), p.key, { hook: false });
      const id = order.id as Hex;
      const body = await signedRefundBody(s, id, USDT(2), 0, s.tenant.refundKey);
      const rs = await Promise.all([postRefund(s, body), postRefund(s, body)]);
      rs.push(await postRefund(s, body));
      assert.ok(rs.every((r) => r.status < 500), JSON.stringify(rs.map((r) => [r.status, errCode(r)])));
      const ok = rs.filter((r) => r.status === 200);
      assert.ok(ok.length >= 1);
      assert.equal(new Set(ok.map((r) => r.json.id)).size, 1);
      const refund = await waitRefund(s, id, ok[0]!.json.id);
      ev.txs.push({ label: "S5 refund (duplicate POSTs)", hash: refund.txHash! });
      assert.equal((await listRefunds({ baseUrl: s.relayerUrl, apiKey: s.tenant.apiKey, orderId: id })).length, 1);
      assert.equal(await chainEventCount(s, id, "Refunded"), 1);
    },
  },
  {
    id: "S6", title: "Relayer killed after the raw tx is persisted and before the RPC reply reconciles to the same hash",
    localOnly: true,
    given: "a fault proxy that forwards the broadcast to the node and then holds the reply forever",
    when: "the relayer process is SIGKILLed mid-broadcast (by PID) and restarted on the same database",
    then: "the order settles with the hash the node received, and the chain shows exactly one payment",
    async run(s, ev) {
      const p = await s.newPayer(USDT(50));
      const order = await newOrder(s, USDT(3), { hook: false });
      const sig = await signPay(order, p.key);
      const n0 = await nonceCount(s);
      s.proxy!.arm("hang-after-send", 1);
      const inflight = relayPay(s, sig).catch(() => undefined);
      const hash = await waitUntil(() => s.proxy!.faulted[s.proxy!.faulted.length - 1], "broadcast reaching the node", 20_000);
      const killedPid = s.relayer.pid;
      await s.restartRelayer(); // SIGKILL by PID, then a fresh process on the same DATABASE_PATH
      assert.notEqual(s.relayer.pid, killedPid);
      s.proxy!.releaseHeld();
      await inflight;
      const settled = await waitStatus(s, order.id as Hex, ["settled"], 90_000);
      assert.equal(settled.txHash?.toLowerCase(), hash.toLowerCase(), "same hash as the persisted raw tx");
      ev.txs.push({ label: "S6 pay (relayer killed mid-broadcast)", hash });
      assert.equal((await nonceCount(s)) - n0, 1, "no second payment");
      assert.equal(await chainEventCount(s, order.id as Hex, "Paid"), 1);
      const again = await relayPay(s, sig);
      assert.equal(again.json.txHash?.toLowerCase(), hash.toLowerCase());
    },
  },
  {
    id: "S7", title: "RPC accepts the tx then closes the connection: the order stays pending, never unpaid",
    localOnly: true,
    given: "a fault proxy that forwards eth_sendRawTransaction to the node and then drops the socket, for every client retry",
    when: "the payment is relayed",
    then: "the order is pending (not failed or expired) while the broadcast is uncertain, then settles to the accepted hash with one payment",
    async run(s, ev) {
      const p = await s.newPayer(USDT(50));
      const order = await newOrder(s, USDT(3), { hook: false });
      const sig = await signPay(order, p.key);
      const n0 = await nonceCount(s);
      s.proxy!.arm("drop-after-send", 50);
      const seen = new Set<string>();
      const r = await relayPay(s, sig);
      seen.add((await read(s, order.id as Hex)).status);
      const first = s.proxy!.faulted[0];
      assert.ok(first, "node received the tx");
      assert.ok(r.status === 200 || r.status < 500, `relay answered ${r.status}`);
      s.proxy!.arm("pass", 0);
      const end = Date.now() + 90_000;
      let final = await read(s, order.id as Hex);
      while (final.status !== "settled" && Date.now() < end) {
        seen.add(final.status);
        assert.ok(!["failed", "expired"].includes(final.status), `order became ${final.status}`);
        await sleep(500);
        final = await read(s, order.id as Hex);
      }
      assert.equal(final.status, "settled");
      assert.ok([...seen].every((x) => ["pending", "created", "settled"].includes(x)), [...seen].join());
      assert.equal(final.txHash?.toLowerCase(), first.toLowerCase());
      ev.txs.push({ label: "S7 pay (RPC dropped the reply)", hash: first });
      assert.equal((await nonceCount(s)) - n0, 1);
      assert.equal(await chainEventCount(s, order.id as Hex, "Paid"), 1);
    },
  },
  {
    id: "S8", title: "Webhook sink down for two attempts then up: exactly one successful delivery recorded",
    given: "a merchant sink that answers 503 to the next two deliveries",
    when: "the order settles and the relayer retries with its backoff",
    then: "the sink sees two failures and one 200 for the same event id, and the relayer's delivery row is delivered after two failed attempts",
    async run(s) {
      s.sink.failNext(2);
      const p = await s.newPayer(USDT(50));
      const { order } = await payOrder(s, USDT(2), p.key);
      const okHit = await waitUntil(() => hitsFor(s, order.id, "payment.settled").find((h) => h.status === 200), "third delivery", 120_000, 500);
      const all = hitsFor(s, order.id, "payment.settled");
      assert.equal(all.filter((h) => h.status !== 200).length, 2);
      assert.equal(all.filter((h) => h.status === 200).length, 1);
      assert.equal(new Set(all.map((h) => JSON.parse(h.body).id)).size, 1, "same event id on every attempt");
      const seenIds = new Set<string>();
      const ev = verifyWebhook({ secret: s.webhookSecretOf(s.tenant), body: okHit.body, signatureHeader: okHit.sig, isDuplicate: (id) => (seenIds.has(id) ? true : (seenIds.add(id), false)) });
      assert.equal(ev.type, "payment.settled");
      await sleep(4000); // no redelivery after success
      assert.equal(hitsFor(s, order.id, "payment.settled").length, 3);
      const db = new Database(`${s.tmp}/relayer.db`, { readonly: true });
      try {
        const row = db.prepare("SELECT attempts, delivered_at FROM deliveries WHERE order_id = ? AND body LIKE '%payment.settled%'").get(order.id) as { attempts: number; delivered_at: number | null };
        assert.equal(row.attempts, 2);
        assert.ok(row.delivered_at);
      } finally { db.close(); }
    },
  },
  {
    id: "S9", title: "A modified webhook body and a stale timestamp fail verification",
    given: "a genuine signed payment.settled captured by the sink",
    when: "the body is altered, the signature is altered, the timestamp is too old, or a second merchant's secret is used",
    then: "each is rejected by verifyWebhook, and the untouched delivery verifies",
    async run(s) {
      const hit = s.sink.hits.slice().reverse().find((h) => h.status === 200);
      assert.ok(hit, "run S2 first");
      const t = Number(/t=(\d+)/.exec(hit.sig)![1]);
      assert.doesNotThrow(() => verifyHit(s, s.tenant, hit));
      const tampered = hit.body.replace(/"amount":"(\d+)"/, (_m, a) => `"amount":"${BigInt(a) + 1n}"`);
      assert.notEqual(tampered, hit.body);
      assert.throws(() => verifyHit(s, s.tenant, { body: tampered, sig: hit.sig }), WebhookVerificationError);
      assert.throws(() => verifyHit(s, s.tenant, { body: hit.body + " ", sig: hit.sig }), WebhookVerificationError);
      assert.throws(() => verifyHit(s, s.tenant, { body: hit.body, sig: hit.sig.replace(/v1=./, "v1=0") }), WebhookVerificationError);
      assert.throws(() => verifyHit(s, s.tenant, hit, { nowSeconds: t + 301 }), WebhookVerificationError);
      assert.throws(() => verifyHit(s, s.other!, hit), WebhookVerificationError, "another merchant's secret must not verify");
    },
  },
  {
    id: "S10", title: "The indexer export verifies against the chain with the verifier CLI and a tampered row fails",
    localOnly: true,
    given: "the payments and refunds of the earlier scenarios on chain",
    when: "the indexer runs and exports an anchored range, and the verifier CLI checks it with --no-payto, --from/--to and --min-confirmations",
    then: "the verifier exits 0 on the export and non-zero on a CSV with one altered amount",
    async run(s, ev) {
      await s.owner!.mine(3);
      const r = await runIndexVerify(s, { from: s.owner!.startBlock, confirmations: 1, label: "local" });
      ev.notes.push(`S10 verifier checkpoint: ${r.checkpoint}`);
      assert.equal(r.okExit, 0, r.okOut);
      assert.notEqual(r.tamperExit, 0, "tampered CSV must fail");
      assert.ok(r.rows > 0);
    },
  },
];

// ---------------------------------------------------------------------------------------------------- attacks (anvil)

export const attacks: Scenario[] = [
  {
    id: "A1", title: "Attack: a payer replays another payer's signature",
    localOnly: true,
    given: "payer A has a valid signature for order 1; attacker B holds USDT and zero WBT",
    when: "B submits A's signature against order 2, with A's address and with B's address, and A's signature is replayed on order 1 again",
    then: "both attempts on order 2 are refused (bad_signature) with no transaction; the replay on order 1 returns the original hash and sends nothing",
    async run(s) {
      const a = await s.newPayer(USDT(50)), b = await s.newPayer(USDT(50));
      const o1 = await newOrder(s, USDT(3), { hook: false });
      const sigA = await signPay(o1, a.key);
      const r1 = await relayPay(s, sigA);
      assert.equal(r1.status, 200);
      await waitStatus(s, o1.id as Hex, ["settled"]);
      const o2 = await newOrder(s, USDT(3), { hook: false });
      const n0 = await nonceCount(s);
      for (const payer of [a.address, b.address]) {
        const r = await relayPay(s, { ...sigA, orderId: o2.id as Hex, payer });
        assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
        assert.equal(errCode(r), "bad_signature");
      }
      const replay = await relayPay(s, sigA);
      assert.equal(replay.json.txHash?.toLowerCase(), r1.json.txHash?.toLowerCase());
      assert.equal((await nonceCount(s)) - n0, 0, "no transaction for any replay");
      assert.equal((await read(s, o2.id as Hex)).status, "created");
      assert.equal(await s.usdtOf(b.address), USDT(50));
    },
  },
  {
    id: "A2", title: "Attack: another merchant guesses an order id (cross-tenant read and refund)",
    localOnly: true,
    given: "a settled, refunded order of merchant A and merchant B's valid API key",
    when: "B reads A's refund context, refunds and refund by id, lists orders, tries to refund it, and creates an order for A's merchant id",
    then: "every call is refused (4xx, never A's data), B's order list excludes the order, and A's data is untouched",
    async run(s) {
      const o = s.other!;
      const p = await s.newPayer(USDT(50));
      const { order } = await payOrder(s, USDT(4), p.key, { hook: false });
      const id = order.id as Hex;
      const rf = await doRefund(s, id, 0, USDT(1));
      const deny = async (label: string, r: { status: number; json: unknown }) => {
        assert.ok(r.status >= 400 && r.status < 500, `${label}: status ${r.status}`);
        assert.ok(!JSON.stringify(r.json).includes(p.address.slice(2).toLowerCase()), `${label}: leaked payer`);
      };
      await deny("refund-context", await get(`${s.relayerUrl}/v1/orders/${id}/refund-context`, o.apiKey));
      await deny("order refunds", await get(`${s.relayerUrl}/v1/orders/${id}/refunds`, o.apiKey));
      await deny("refund by id", await get(`${s.relayerUrl}/v1/refunds/${rf.id}`, o.apiKey));
      const body = await signedRefundBody(s, id, USDT(1), 1, o.refundKey, s.tenant).catch(() => ({ orderId: id, amount: "1000000", refundIndex: 1, validAfter: 1, validBefore: 2e10, signature: ("0x" + "11".repeat(65)) as Hex }));
      await deny("refund as B", await postRefund(s, body, o));
      await deny("create order for A's id", await post(`${s.relayerUrl}/v1/orders`, { merchantId: s.tenant.merchantId, amount: "1000000" }, o.apiKey));
      const mine = (await get(`${s.relayerUrl}/v1/orders`, o.apiKey)).json.orders as { id: string }[];
      assert.ok(!mine.some((x) => x.id.toLowerCase() === id.toLowerCase()));
      assert.equal((await read(s, id)).status, "partially_refunded");
      assert.equal(await chainEventCount(s, id, "Refunded"), 1);
    },
  },
  {
    id: "A3", title: "Attack: relay endpoint called with a payer that holds WBT",
    localOnly: true,
    given: "a payer holding 1 WBT",
    when: "the payment is relayed",
    then: "the relayer pays all gas: the payer's WBT is unchanged and the relayer's WBT dropped, so the endpoint cannot be used to spend the payer's gas",
    async run(s) {
      const p = await s.newPayer(USDT(50));
      await fetch(s.chainRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [p.address, "0xde0b6b3a7640000"] }) });
      const w0 = await s.wbtOf(p.address), r0 = await relayerWbt(s);
      assert.equal(w0, 10n ** 18n);
      await payOrder(s, USDT(3), p.key, { hook: false });
      assert.equal(await s.wbtOf(p.address), w0);
      assert.ok((await relayerWbt(s)) < r0);
    },
  },
  {
    id: "A4", title: "Attack: refund signed by the wrong key",
    localOnly: true,
    given: "a settled order and refund requests signed by a random key and by another merchant's refund signer",
    when: "each is POSTed with the right merchant's API key",
    then: "both are refused with bad_signature and nothing is refunded",
    async run(s) {
      const p = await s.newPayer(USDT(50));
      const { order } = await payOrder(s, USDT(4), p.key, { hook: false });
      const id = order.id as Hex;
      for (const key of [generatePrivateKey(), s.other!.refundKey]) {
        const r = await postRefund(s, await signedRefundBody(s, id, USDT(1), 0, key));
        assert.ok(r.status >= 400 && r.status < 500);
        assert.equal(errCode(r), "bad_signature");
      }
      assert.equal(await chainEventCount(s, id, "Refunded"), 0);
      assert.equal((await listRefunds({ baseUrl: s.relayerUrl, apiKey: s.tenant.apiKey, orderId: id })).length, 0);
    },
  },
  {
    id: "A5", title: "Attack: stale or skipped refund index",
    localOnly: true,
    given: "an order with refund index 0 already used",
    when: "a new refund is signed for index 0 again, for index 5, and the SDK is asked for a stale index",
    then: "all are refused and only the first refund exists",
    async run(s) {
      const p = await s.newPayer(USDT(50));
      const { order } = await payOrder(s, USDT(6), p.key, { hook: false });
      const id = order.id as Hex;
      await doRefund(s, id, 0, USDT(1));
      for (const idx of [0, 5]) {
        const r = await postRefund(s, await signedRefundBody(s, id, USDT(1), idx, s.tenant.refundKey));
        assert.ok(r.status >= 400 && r.status < 500, `index ${idx}: ${r.status}`);
        assert.equal(errCode(r), "already_settled");
      }
      assert.match((await codeOf(doRefund(s, id, 0, USDT(1))))!, /Refund index changed/);
      assert.equal(await chainEventCount(s, id, "Refunded"), 1);
    },
  },
  {
    id: "A6", title: "Attack: refund and pay while the router is paused",
    localOnly: true,
    given: "a settled order and a router paused by its owner",
    when: "a refund and a new payment are submitted, then the router is unpaused",
    then: "both are refused while paused (relayer_paused) with no transaction, and the refund succeeds after unpausing",
    async run(s) {
      const p = await s.newPayer(USDT(50));
      const { order } = await payOrder(s, USDT(4), p.key, { hook: false });
      const id = order.id as Hex;
      const o2 = await newOrder(s, USDT(2), { hook: false });
      const sig2 = await signPay(o2, p.key);
      await s.owner!.pause();
      try {
        const n0 = await nonceCount(s);
        const rr = await postRefund(s, await signedRefundBody(s, id, USDT(1), 0, s.tenant.refundKey));
        assert.ok(rr.status >= 400 && rr.status < 500, `refund while paused: ${rr.status}`);
        assert.equal(errCode(rr), "relayer_paused");
        const rp = await relayPay(s, sig2);
        assert.ok(rp.status >= 400 && rp.status < 500, `pay while paused: ${rp.status}`);
        assert.equal(errCode(rp), "relayer_paused");
        assert.equal((await nonceCount(s)) - n0, 0);
      } finally { await s.owner!.unpause(); }
      await doRefund(s, id, 0, USDT(1));
      assert.equal(await chainEventCount(s, id, "Refunded"), 1);
    },
  },
  {
    id: "A7", title: "Attack: cheap invalid requests cannot exhaust the loss budget",
    localOnly: true,
    given: "a relayer with a very small hourly loss budget (0.0005 WBT)",
    when: "80 invalid requests are sent (bad signatures, wrong amounts, unknown orders, payers without USDT)",
    then: "the relayer's WBT balance does not move, recorded spend stays within the budget, and a legitimate payment still settles afterwards",
    async run(s) {
      await s.restartRelayer({ LOSS_BUDGET_WBT_PER_HOUR: "0.0005" });
      const r0 = await relayerWbt(s);
      const poor = privateKeyToAccount(generatePrivateKey());
      const p = await s.newPayer(USDT(50));
      const stranger = generatePrivateKey();
      const order = await newOrder(s, USDT(2), { hook: false });
      const reqs: Promise<unknown>[] = [];
      for (let i = 0; i < 20; i++) {
        const forged = await signPay(order, stranger, { payerAddress: p.address });
        reqs.push(relayPay(s, forged)); // signature does not match payer
        reqs.push(relayPay(s, { ...forged, orderId: ("0x" + (i + 1).toString(16).padStart(64, "0")) as Hex })); // unknown order
        reqs.push(relayPay(s, { ...forged, amount: "1" })); // wrong amount
        const pOrder = await newOrder(s, USDT(2), { hook: false });
        reqs.push(relayPay(s, await signPay(pOrder, poor.address ? generatePrivateKey() : stranger))); // valid signature, payer holds nothing
      }
      const results = (await Promise.all(reqs)) as { status: number }[];
      assert.ok(results.every((r) => r.status < 500), JSON.stringify(results.map((r) => r.status)));
      const m = (await get(`${s.relayerUrl}/v1/metrics`, s.operatorToken)).json;
      assert.ok(Number(m.lossBudget.spentWbtLastHour) <= Number(m.lossBudget.limitWbtPerHour), JSON.stringify(m.lossBudget));
      const spent = r0 - (await relayerWbt(s));
      assert.ok(spent <= 500_000_000_000_000n, `relayer lost ${spent} wei to junk`);
      await payOrder(s, USDT(2), p.key, { hook: false });
      await s.restartRelayer({});
    },
  },
  {
    id: "A8", title: "Attack surface: restart during a refund",
    localOnly: true,
    given: "a refund whose broadcast reaches the node while the relayer's reply is lost",
    when: "the relayer is killed by PID mid-refund and restarted",
    then: "exactly one refund settles with the broadcast hash, and a repeat of the same request creates no second refund",
    async run(s, ev) {
      const p = await s.newPayer(USDT(50));
      const { order } = await payOrder(s, USDT(6), p.key, { hook: false });
      const id = order.id as Hex;
      const body = await signedRefundBody(s, id, USDT(2), 0, s.tenant.refundKey);
      s.proxy!.arm("hang-after-send", 1);
      const inflight = postRefund(s, body).catch(() => undefined);
      const hash = await waitUntil(() => s.proxy!.faulted[s.proxy!.faulted.length - 1], "refund broadcast", 20_000);
      await s.restartRelayer();
      s.proxy!.releaseHeld();
      await inflight;
      const refund = await waitUntil(async () => (await listRefunds({ baseUrl: s.relayerUrl, apiKey: s.tenant.apiKey, orderId: id })).find((r) => r.status === "settled"), "refund to settle", 90_000, 500);
      assert.equal(refund.txHash?.toLowerCase(), hash.toLowerCase());
      ev.txs.push({ label: "A8 refund (relayer killed mid-refund)", hash });
      const again = await postRefund(s, body);
      assert.ok(again.status < 500);
      assert.equal((await listRefunds({ baseUrl: s.relayerUrl, apiKey: s.tenant.apiKey, orderId: id })).length, 1);
      assert.equal(await chainEventCount(s, id, "Refunded"), 1);
    },
  },
];

export async function runScenarios(s: Stack, list: Scenario[], ev: Evidence): Promise<{ id: string; ok: boolean; err?: string }[]> {
  const out: { id: string; ok: boolean; err?: string }[] = [];
  for (const sc of list) {
    log(`\nScenario ${sc.id}: ${sc.title}\n  Given ${sc.given}\n  When  ${sc.when}\n  Then  ${sc.then}`);
    try { await sc.run(s, ev); out.push({ id: sc.id, ok: true }); log(`  -> PASS ${sc.id}`); }
    catch (e) { out.push({ id: sc.id, ok: false, err: (e as Error).message }); log(`  -> FAIL ${sc.id}: ${(e as Error).message}`); }
  }
  return out;
}

export { createOrder };
