import { describe, it, expect, vi } from "vitest";
import { setup, MERCHANT_ID, nonce } from "./helpers.js";
import type { Hex } from "viem";

// Backend audit F13: anyone who sees the agent's signed authorization can submit it first. The money
// reaches the payee, our own tx reverts, and we must NOT report the payment as failed.

const FOREIGN = ("0x" + "f0".repeat(32)) as Hex;
const matched = (confirmations: number, hash: Hex = FOREIGN, logIndex = 3) =>
  ({ kind: "matched", hash, blockNumber: 1n, logIndex, confirmations }) as const;
const row = (e: ReturnType<typeof setup>, n = 1) =>
  e.db.raw.prepare("SELECT * FROM x402_payments WHERE nonce=?").get(nonce(n)) as Record<string, unknown>;
const settled = async (e: ReturnType<typeof setup>, n = 1) => {
  await vi.waitFor(() => expect(row(e, n).status).not.toBe("settling"), { timeout: 2000 });
  return row(e, n);
};

describe("F13 front-run: a third party consumes the signed authorization first", () => {
  it("settles with the foreign tx hash once it is deep enough, delivers exactly once, and keeps our gas spend", async () => {
    const e = setup();
    e.state.frontRun = true;
    e.state.external = matched(2);
    const req = await e.request();
    await e.service.settle(req, MERCHANT_ID);
    const r = await settled(e);
    expect(r.status).toBe("settled");
    expect(r.tx_hash).toBe(FOREIGN);
    expect(r.error_reason).toBeNull();
    expect(r.settlement_source).toBe("external");
    expect(r.settlement_log_index).toBe(3);
    // our reverted tx still burned gas and still counts against the loss budget
    const ours = e.state.sent[0]!.hash;
    expect(e.db.raw.prepare("SELECT COUNT(*) n FROM spend WHERE tx_hash=?").get(ours)).toEqual({ n: 1 });
    // the retry sees a settled payment, delivery is granted once and then refused
    const again = await e.service.settle(req, MERCHANT_ID);
    expect(again).toMatchObject({ success: true, transaction: FOREIGN });
    const first = e.service.claim(req, MERCHANT_ID);
    expect(first.success).toBe(true);
    expect(e.service.delivery(first.paymentId!, first.leaseToken!, MERCHANT_ID, "complete").success).toBe(true);
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(false);
    expect(e.state.sent).toHaveLength(1);
  });

  it("stays pending while the foreign tx is shallow, never delivers, then settles when it is deep enough", async () => {
    const e = setup();
    e.state.frontRun = true;
    e.state.external = matched(1);
    const req = await e.request();
    const first = await e.service.settle(req, MERCHANT_ID);
    await vi.waitFor(() => expect(e.state.externalLookups).toBeGreaterThan(0));
    expect(row(e).status).toBe("settling");
    expect(first.success).toBe(false);
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(false);
    // the foreign tx is reorged out: still pending, still nothing delivered
    e.state.external = { kind: "none" };
    const before = e.state.externalLookups;
    await vi.waitFor(async () => {
      await e.service.recover(row(e).id as string);
      expect(e.state.externalLookups).toBeGreaterThan(before);
    });
    expect(row(e).status).toBe("settling");
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(false);
    // it lands again and gets deep
    e.state.external = matched(2);
    await vi.waitFor(async () => {
      await e.service.recover(row(e).id as string);
      expect(row(e).status).toBe("settled");
    });
    expect(row(e).tx_hash).toBe(FOREIGN);
  });

  it("fails a cancelled authorization (used, but not paid) and delivers nothing", async () => {
    const e = setup();
    e.state.frontRun = true;
    e.state.external = { kind: "cancelled" };
    const req = await e.request();
    await e.service.settle(req, MERCHANT_ID);
    const r = await settled(e);
    expect(r.status).toBe("failed");
    expect(r.error_reason).toBe("authorization_cancelled");
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(false);
  });

  it("parks a used nonce it cannot bind to a payment as unresolved: no delivery, no retry, no new send", async () => {
    const e = setup();
    e.state.frontRun = true;
    e.state.external = { kind: "unknown" };
    const req = await e.request();
    await e.service.settle(req, MERCHANT_ID);
    const r = await settled(e);
    expect(r.status).toBe("unresolved");
    expect(r.error_reason).toBe("settlement_unresolved");
    const again = await e.service.settle(req, MERCHANT_ID);
    expect(again).toMatchObject({ success: false, errorReason: "settlement_unresolved" });
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(false);
    expect(e.state.sent).toHaveLength(1);
  });

  it("a revert for any other reason (nonce NOT used) is still a plain failure", async () => {
    const e = setup();
    e.state.frontRun = true;
    e.state.external = { kind: "none" };
    // our tx reverts (e.g. out of gas / token paused) but the chain says the nonce is still unused
    const req = await e.request();
    e.chain.authorizationUsed = async () => false;
    await e.service.settle(req, MERCHANT_ID);
    const r = await settled(e);
    expect(r.status).toBe("failed");
    expect(r.error_reason).toBe("invalid_transaction_state");
  });

  it("one foreign tx cannot be claimed by two payments", async () => {
    const e = setup();
    e.state.frontRun = true;
    e.state.external = matched(2);
    await e.service.settle(await e.request(1), MERCHANT_ID);
    expect((await settled(e, 1)).status).toBe("settled");
    await e.service.settle(await e.request(2), MERCHANT_ID);
    const second = await settled(e, 2);
    expect(second.status).toBe("unresolved");
    expect(second.tx_hash).not.toBe(FOREIGN);
  });

  it("handles the foreign tx landing before our send (simulation already fails): settled, nothing broadcast", async () => {
    const e = setup();
    e.state.usedAtSimulateCall = 2; // verify passes, the send-time simulation sees the used nonce
    e.state.external = matched(2);
    const req = await e.request();
    const res = await e.service.settle(req, MERCHANT_ID);
    expect(res).toMatchObject({ success: true, transaction: FOREIGN });
    expect(row(e).status).toBe("settled");
    expect(row(e).settlement_source).toBe("external");
    expect(e.state.sent).toHaveLength(0);
  });

  it("does not turn a simulation failure with an UNUSED nonce into a settlement", async () => {
    const e = setup();
    e.state.usedAtSimulateCall = 0;
    e.state.simulationFails = true;
    const res = await e.service.settle(await e.request(), MERCHANT_ID);
    expect(res.success).toBe(false);
    expect(e.state.externalLookups).toBe(0);
  });
});
