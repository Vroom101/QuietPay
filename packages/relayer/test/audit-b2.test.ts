import { describe, expect, it } from "vitest";
import { QuietpayError } from "@quietpay/shared";
import { makeEnv, newOrder } from "./helpers.js";

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  return err instanceof QuietpayError ? err.code : err === null ? null : "non-quietpay-error";
}

import { signFor, MERCHANT_ID, refundSigner, payer, ROUTER } from "./helpers.js";
import { ERROR_CODES, ERROR_HTTP_STATUS, buildRefundAuthorization } from "@quietpay/shared";
import { WebhookEvent } from "@quietpay/shared/webhook";
import { buildServer } from "../src/server.js";
import type { Hex } from "viem";

const ctx = { ip: "203.0.113.9" };
const tick = () => new Promise((r) => setTimeout(r, 15));

// Backend audit B2.2 (R16): with SETTLE_CONFIRMATIONS > 1 a receipt only settles once it is buried deep enough,
// and a receipt that disappears again (reorg) never leaves a settled order or a payment.settled webhook behind.
describe("audit R16: settlement waits for confirmation depth and survives a reorg", () => {
  async function relayed(confirmations: number) {
    const e = makeEnv({ settleConfirmations: confirmations });
    const order = await newOrder(e.svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    e.chain.head = 1n; // the receipt is in block 1: head 1 means 1 confirmation
    await e.svc.relayPay(await signFor(order, e.clock.t), ctx);
    await tick();
    return { ...e, order };
  }
  const events = (e: Awaited<ReturnType<typeof relayed>>) =>
    e.db.raw.prepare("SELECT COUNT(*) n FROM deliveries WHERE body LIKE '%payment.settled%'").get() as { n: number };

  it("stays pending while the receipt is shallow, then settles exactly once when it is deep enough", async () => {
    const e = await relayed(3);
    expect(e.svc.getOrder(e.order.id).status).toBe("pending");
    expect(events(e).n).toBe(0);
    e.chain.head = 2n; // 2 confirmations: still shallow
    await e.svc.reconcile();
    expect(e.svc.getOrder(e.order.id).status).toBe("pending");
    e.chain.head = 3n; // 3 confirmations
    await e.svc.reconcile();
    await e.svc.reconcile();
    expect(e.svc.getOrder(e.order.id).status).toBe("settled");
    expect(events(e).n).toBe(1);
  });

  it("a receipt that vanishes (reorg) while shallow never settles the order", async () => {
    const e = await relayed(3);
    e.chain.holdReceipt = true; // the node no longer has a receipt for the tx
    e.chain.head = 50n;
    await e.svc.reconcile();
    expect(e.svc.getOrder(e.order.id).status).toBe("pending");
    expect(events(e).n).toBe(0);
  });

  it("the default (1 confirmation) keeps settling on the first receipt", async () => {
    const e = await relayed(1);
    expect(e.svc.getOrder(e.order.id).status).toBe("settled");
    expect(events(e).n).toBe(1);
  });
});

// Backend audit B2.2 (R23): a refund the signer cannot fund is refused and changes nothing at all.
describe("audit R23: insufficient_refund_balance changes no state", () => {
  it("leaves the order, refund table, spend ledger and webhook queue exactly as they were", async () => {
    const e = makeEnv();
    const order = await newOrder(e.svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    await e.svc.relayPay(await signFor(order, e.clock.t), ctx);
    await tick();
    expect(e.svc.getOrder(order.id).status).toBe("settled");
    const snapshot = () => ({
      order: JSON.stringify(e.svc.getOrder(order.id)),
      refunds: e.db.raw.prepare("SELECT COUNT(*) n FROM refunds").get(),
      spend: e.db.raw.prepare("SELECT COUNT(*) n, COALESCE(SUM(CAST(wei AS INTEGER)),0) s FROM spend").get(),
      deliveries: e.db.raw.prepare("SELECT COUNT(*) n FROM deliveries").get(),
      attempts: e.db.raw.prepare("SELECT COUNT(*) n FROM relay_attempts").get(),
    });
    const before = snapshot();
    e.chain.refundBalance = 1n;
    const signature = await refundSigner.signTypedData(
      buildRefundAuthorization({
        merchantId: MERCHANT_ID, orderId: order.id as Hex, payer: payer.address, refundSigner: refundSigner.address, router: ROUTER,
        amount: 5_000_000n, refundIndex: 0n, validAfter: BigInt(e.clock.t - 5), validBefore: BigInt(e.clock.t + 300),
        token: e.cfg.usdt, chainId: e.cfg.chainId, domainName: e.cfg.tokenDomain.name, domainVersion: e.cfg.tokenDomain.version,
      }),
    );
    const req = { orderId: order.id, amount: "5000000", refundIndex: 0, validAfter: e.clock.t - 5, validBefore: e.clock.t + 300, signature };
    expect(await codeOf(e.svc.refunds.submit(MERCHANT_ID, req as never, "203.0.113.1"))).toBe("insufficient_refund_balance");
    await tick();
    expect(snapshot()).toEqual(before);
    expect(e.chain.refundPrepared).toHaveLength(0);
  });
});

// Backend audit B2.2 (R19): every webhook event carries a unique id, which is what receivers dedupe on.
describe("audit R19: payment.settled and payment.failed events carry an id", () => {
  const events = (e: ReturnType<typeof makeEnv>) =>
    (e.db.raw.prepare("SELECT body FROM deliveries").all() as { body: string }[]).map((r) => WebhookEvent.parse(JSON.parse(r.body)));

  it("settled", async () => {
    const e = makeEnv();
    const order = await newOrder(e.svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    await e.svc.relayPay(await signFor(order, e.clock.t), ctx);
    await tick();
    const evs = events(e);
    expect(evs.map((x) => x.type)).toEqual(["payment.settled"]);
    expect(evs[0]!.id).toMatch(/\S{8,}/);
  });

  it("failed, and ids differ between events", async () => {
    const e = makeEnv();
    e.chain.receiptStatus = "reverted";
    const o1 = await newOrder(e.svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    await e.svc.relayPay(await signFor(o1, e.clock.t), ctx);
    await tick();
    const evs = events(e);
    expect(evs.map((x) => x.type)).toEqual(["payment.failed"]);
    expect(evs[0]!.id).toMatch(/\S{8,}/);
    const ok = makeEnv();
    const o2 = await newOrder(ok.svc, "25000000", { webhookUrl: "https://merchant.test/hook" });
    await ok.svc.relayPay(await signFor(o2, ok.clock.t), ctx);
    await tick();
    expect(events(ok)[0]!.id).not.toBe(evs[0]!.id);
  });
});

// Backend audit B2.2 (R22): every frozen error code leaves the HTTP layer as {error:{code,message}} with its frozen status,
// a non-empty plain-words message and nothing that looks like a stack trace, path or secret.
describe("audit R22: every frozen error code over HTTP", () => {
  it.each(ERROR_CODES)("%s", async (code) => {
    const e = makeEnv();
    const app = buildServer(e.svc);
    (e.svc as unknown as { getOrder: () => never }).getOrder = () => {
      throw new QuietpayError(code);
    };
    const res = await app.inject({ method: "GET", url: "/v1/orders/" + "0x" + "ab".repeat(32) });
    expect(res.statusCode).toBe(ERROR_HTTP_STATUS[code]);
    const body = res.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(res.body).not.toMatch(/\bat \S+\(|node_modules|\.ts:\d+|0x[0-9a-fA-F]{64}|PRIVATE|stack/i);
    await app.close();
  });
});

// Backend audit B2.2 (R4): the router needs value > fee, so an order whose amount is not strictly
// greater than the relay fee must be refused when it is created, before anything can be broadcast.
describe("audit R4: amount must be strictly greater than the relay fee", () => {
  const FEE = 50_000n; // makeCfg relayFee, below the merchant's 100_000 cap

  it("refuses amount == fee and amount < fee with invalid_amount, and never touches the chain", async () => {
    const { svc, chain } = makeEnv();
    for (const amount of [FEE, FEE - 1n, 1n]) {
      expect(await codeOf(newOrder(svc, amount.toString()))).toBe("invalid_amount");
    }
    expect(chain.sent).toHaveLength(0);
  });

  it("accepts amount == fee + 1 and records the quoted fee on the order", async () => {
    const { svc } = makeEnv();
    const order = await newOrder(svc, (FEE + 1n).toString());
    expect(order.fee).toBe(FEE.toString());
    expect(BigInt(order.amount)).toBe(FEE + 1n);
  });

  it("uses the lower of the configured fee and the merchant's cap when checking", async () => {
    // Merchant cap 100_000, configured fee 150_000 -> effective fee 100_000, so 100_000 is refused and 100_001 passes.
    const { svc } = makeEnv({ relayFee: 150_000n });
    expect(await codeOf(newOrder(svc, "100000"))).toBe("invalid_amount");
    const order = await newOrder(svc, "100001");
    expect(order.fee).toBe("100000");
  });
});
