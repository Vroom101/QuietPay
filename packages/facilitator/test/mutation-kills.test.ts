import { describe, it, expect, vi } from "vitest";
import { buildAgentAuthorization } from "@quietpay/shared";
import { MERCHANT_ID, payer, setup, nonce } from "./helpers.js";
import { PAYOUT } from "../../relayer/test/helpers.js";

// Each test pins behaviour that a mutation run showed no test was guarding (docs/b/mutation-results.md).
const OTHER_MERCHANT = "0x" + "02".repeat(32);

async function signed(e: ReturnType<typeof setup>, over: { value?: bigint; validAfter?: bigint; n?: number } = {}) {
  const req = structuredClone(await e.request(over.n ?? 1));
  const a = req.paymentPayload.payload.authorization;
  if (over.value !== undefined) a.value = String(over.value);
  if (over.validAfter !== undefined) a.validAfter = String(over.validAfter);
  req.paymentPayload.payload.signature = await payer.signTypedData(
    buildAgentAuthorization({
      from: a.from as `0x${string}`,
      to: a.to as `0x${string}`,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce as `0x${string}`,
    }),
  );
  return req;
}

describe("mutation kills: facilitator", () => {
  it("F1: a correctly signed authorization for a different amount is refused with value_mismatch", async () => {
    const e = setup();
    const res = await e.service.verify(await signed(e, { value: 1n }), MERCHANT_ID);
    expect(res).toEqual({ isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_value_mismatch" });
    expect((await e.service.settle(await signed(e, { value: 1n }), MERCHANT_ID)).success).toBe(false);
    expect(e.state.sent).toHaveLength(0);
  });

  it("F2: an authorization whose validAfter is exactly now is not yet valid", async () => {
    const e = setup();
    const res = await e.service.verify(await signed(e, { validAfter: BigInt(e.clock.t) }), MERCHANT_ID);
    expect(res.invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_after");
    const ok = await e.service.verify(await signed(e, { validAfter: BigInt(e.clock.t - 1) }), MERCHANT_ID);
    expect(ok.isValid).toBe(true);
  });

  it("F3: another resource server's key cannot verify or settle a payment for this merchant's resource", async () => {
    const e = setup();
    const req = await e.request();
    expect(await e.service.verify(req, OTHER_MERCHANT)).toEqual({ isValid: false, invalidReason: "invalid_payment_requirements" });
    expect((await e.service.settle(req, OTHER_MERCHANT)).success).toBe(false);
    expect(e.state.sent).toHaveLength(0);
  });

  it("F9: requirements naming a different payee than the policy are refused (in both the request and the accepted copy)", async () => {
    const e = setup();
    for (const where of ["paymentRequirements", "accepted"] as const) {
      const req = structuredClone(await e.request());
      const target = where === "accepted" ? req.paymentPayload.accepted : req.paymentRequirements;
      target.payTo = "0x" + "99".repeat(20);
      expect((await e.service.verify(req, MERCHANT_ID)).invalidReason, where).toBe("invalid_payment_requirements");
    }
    // and the signed recipient must equal the policy payee even when the requirements are untouched
    const redirected = structuredClone(await e.request());
    redirected.paymentPayload.payload.authorization.to = "0x" + "99".repeat(20);
    expect((await e.service.verify(redirected, MERCHANT_ID)).isValid).toBe(false);
    expect(PAYOUT).not.toBe("0x" + "99".repeat(20));
  });

  it("F7: a pause that lands while the transfer is being simulated stops the broadcast", async () => {
    const e = setup();
    const sim = e.chain.simulateTransfer.bind(e.chain);
    vi.spyOn(e.chain, "simulateTransfer").mockImplementation(async (a) => {
      const gas = await sim(a);
      e.svc.setLocalPaused(true);
      return gas;
    });
    const res = await e.service.settle(await e.request(), MERCHANT_ID);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("relayer_paused");
    expect(e.state.prepared).toHaveLength(0);
  });

  it("F11: a receipt arriving for a payment that is already settled changes nothing", async () => {
    const e = setup();
    const res = await e.service.settle(await e.request(), MERCHANT_ID);
    expect(res.success).toBe(true);
    const before = e.db.raw.prepare("SELECT status, tx_hash, error_reason FROM x402_payments").get();
    const row = e.db.raw.prepare("SELECT id FROM x402_payments").get() as { id: string };
    const finish = (e.service as unknown as { finish(id: string, h: string, r: unknown): Promise<void> }).finish.bind(e.service);
    await finish(row.id, "0x" + "cd".repeat(32), { status: "reverted", blockNumber: 1n, transfers: [] });
    expect(e.db.raw.prepare("SELECT status, tx_hash, error_reason FROM x402_payments").get()).toEqual(before);
  });

  it("F12: a payer exactly at the daily cap may pay; one unit over is refused", async () => {
    const e = setup({ payerCap: 20000n });
    expect((await e.service.settle(await e.request(1), MERCHANT_ID)).success).toBe(true); // volume 10000 of 20000
    expect((await e.service.settle(await e.request(2), MERCHANT_ID)).success).toBe(true); // lands exactly on the cap
    const third = await e.service.settle(await e.request(3), MERCHANT_ID);
    expect(third.success).toBe(false);
    expect(third.errorReason).toBe("budget_exceeded");
    expect(nonce(3)).toBeDefined();
  });

  it("F11: a success receipt cannot resurrect a payment that is already failed", async () => {
    const e = setup();
    expect((await e.service.settle(await e.request(), MERCHANT_ID)).success).toBe(true);
    const row = e.db.raw.prepare("SELECT id FROM x402_payments").get() as { id: string };
    e.db.raw.prepare("UPDATE x402_payments SET status='failed', error_reason='invalid_transaction_state' WHERE id=?").run(row.id);
    const hash = e.state.prepared[0]!.tx.hash;
    const receipt = await e.chain.getReceipt(hash);
    const finish = (e.service as unknown as { finish(id: string, h: string, r: unknown): Promise<void> }).finish.bind(e.service);
    await finish(row.id, hash, receipt);
    expect(e.db.raw.prepare("SELECT status FROM x402_payments").get()).toEqual({ status: "failed" });
  });
});

// Opus round A findings (docs/b/attack-log.md)
import type { Hex } from "viem";
const FOREIGN = ("0x" + "f0".repeat(32)) as Hex;
const matched = (confirmations: number) => ({ kind: "matched" as const, hash: FOREIGN, blockNumber: 5n, logIndex: 0, confirmations });

describe("round A findings", () => {
  it("A-F2: a payment adopted from a shallow foreign tx still settles on recovery after validBefore has passed", async () => {
    const e = setup();
    e.state.used.add(nonce(1));
    e.state.external = matched(1);
    const req = await e.request();
    expect((await e.service.settle(req, MERCHANT_ID)).errorReason).toBe("settlement_pending");
    e.clock.t += 500; // well past validBefore (now + 55)
    e.state.external = matched(2);
    const row = e.db.raw.prepare("SELECT id FROM x402_payments").get() as { id: string };
    await e.service.recover(row.id);
    expect(e.db.raw.prepare("SELECT status, tx_hash FROM x402_payments").get()).toEqual({ status: "settled", tx_hash: FOREIGN });
  });

  it("A-F3: an expired authorization whose nonce was used elsewhere is NOT adopted (no late redemption of old payments)", async () => {
    const e = setup();
    const req = await e.request();
    e.clock.t += 500;
    e.state.used.add(nonce(1));
    e.state.external = matched(5);
    const res = await e.service.settle(req, MERCHANT_ID);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
    expect(e.db.raw.prepare("SELECT COUNT(*) n FROM x402_payments").get()).toEqual({ n: 0 });
  });

  it("A-F4: reverted x402 sends count as payer reverts, and a payer at the daily limit is refused before another send", async () => {
    const e = setup({ maxRevertsPerDay: 1 });
    e.state.frontRun = true; // our tx reverts ...
    e.chain.authorizationUsed = async () => false; // ... but the nonce stays unused: a plain failure, not a front-run
    await e.service.settle(await e.request(1), MERCHANT_ID);
    await vi.waitFor(() => expect(e.db.revertStats(payer.address, 0).count).toBe(1));
    const sentBefore = e.state.sent.length;
    const second = await e.service.settle(await e.request(2), MERCHANT_ID);
    expect(second.success).toBe(false);
    expect(second.errorReason).toBe("budget_exceeded");
    expect(e.state.sent).toHaveLength(sentBefore);
  });

  it("A-F5: a parked (unresolved) payment still counts toward the payer's daily volume", async () => {
    const e = setup();
    e.state.used.add(nonce(1));
    e.state.external = { kind: "unknown" };
    await e.service.settle(await e.request(), MERCHANT_ID);
    expect(e.db.raw.prepare("SELECT status FROM x402_payments").get()).toEqual({ status: "unresolved" });
    expect(e.db.payerVolume(payer.address, 0)).toBe(10000n);
  });
});
