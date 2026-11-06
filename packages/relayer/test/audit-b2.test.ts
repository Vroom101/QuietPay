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

import { signFor } from "./helpers.js";

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
