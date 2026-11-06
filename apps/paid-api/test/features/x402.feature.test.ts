import { describe, it, expect, vi } from "vitest";
import { decodeX402Header, X402Required, X402SettleResponse, PAYMENT_REQUIRED, PAYMENT_RESPONSE } from "@quietpay/shared";
import { running } from "../build-harness.js";
import { FacilitatorService } from "../../../../packages/facilitator/src/service.js";
import { MERCHANT_ID } from "../../../../packages/facilitator/test/helpers.js";

describe("Feature: an agent pays for an x402 resource", () => {
  it("Scenario: an agent pays and receives data once", async () => {
    const t = await running();
    try {
      // Given a priced resource and an agent holding a signed authorization for exactly that price
      const unpaid = await fetch(t.url + "/v1/quote");
      expect(unpaid.status).toBe(402);
      expect(decodeX402Header(unpaid.headers.get(PAYMENT_REQUIRED)!, X402Required).accepts[0]!.amount).toBe("10000");
      const req = await t.forge();
      // When the agent retries with the payment header
      const paid = await t.get(req);
      // Then it receives the data and a settlement receipt, and the handler ran once
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ protected: "paid-data" });
      expect(decodeX402Header(paid.headers.get(PAYMENT_RESPONSE)!, X402SettleResponse).success).toBe(true);
      expect(t.handler).toHaveBeenCalledTimes(1);
      expect(t.state.sent).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("Scenario: a replayed payment gets nothing (payment_replayed)", async () => {
    const t = await running();
    try {
      // Given an agent that already paid and received the data
      const req = await t.forge();
      expect((await t.get(req)).status).toBe(200);
      await vi.waitFor(() => expect(t.db.raw.prepare("SELECT delivered_at d FROM x402_payments").get()).not.toEqual({ d: null }));
      // When the same header is sent again, by the agent or by anyone who copied it
      const again = await t.get(req);
      // Then there is no data, the reason is payment_replayed, and nothing is charged twice
      expect(again.status).toBe(402);
      expect((await again.json()).error).toBe("payment_replayed");
      expect(t.handler).toHaveBeenCalledTimes(1);
      expect(t.state.sent).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it.each([
    ["wrong price (authorization value)", { value: 1n }, "invalid_exact_evm_payload_authorization_value_mismatch"],
    ["wrong price (accepted amount)", { acceptedPatch: { amount: "1" } }, "invalid_payment_requirements"],
    ["wrong network", { acceptedPatch: { network: "eip155:1" } }, "invalid_payment_requirements"],
    ["wrong recipient", { to: "0x" + "99".repeat(20) }, "invalid_exact_evm_payload_recipient_mismatch"],
    ["expired authorization", { validBefore: 1_799_999_999n }, "invalid_exact_evm_payload_authorization_valid_before"],
    ["not yet valid authorization", { validAfter: 1_800_000_100n, validBefore: 1_800_000_150n }, "invalid_exact_evm_payload_authorization_valid_after"],
  ])("Scenario: %s is refused, no data, nothing sent", async (_name, o, reason) => {
    const t = await running();
    try {
      // Given an authorization that deviates from what the 402 asked for
      const req = await t.forge(o as never);
      // When it is presented
      const res = await t.get(req);
      // Then it is refused with the reason, no tx is sent and the resource never runs
      expect(res.status).toBe(402);
      expect((await res.json()).error).toBe(reason);
      expect(t.handler).not.toHaveBeenCalled();
      expect(t.state.sent).toHaveLength(0);
    } finally {
      await t.close();
    }
  });

  it("Scenario: delivery is released only after a confirmed settlement", async () => {
    const t = await running();
    try {
      // Given a payment whose transaction is broadcast but not yet confirmed
      t.state.hold = true;
      const req = await t.forge();
      // When the agent presents it
      const pending = await t.get(req);
      // Then it gets 402 settlement_pending with the hash and no data
      expect(pending.status).toBe(402);
      expect(decodeX402Header(pending.headers.get(PAYMENT_RESPONSE)!, X402SettleResponse).errorReason).toBe("settlement_pending");
      expect(t.handler).not.toHaveBeenCalled();
      // When the chain confirms
      t.state.hold = false;
      const ok = await t.get(req);
      // Then the data is released, still with only one transaction
      expect(ok.status).toBe(200);
      expect(t.handler).toHaveBeenCalledTimes(1);
      expect(t.state.prepared).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("Scenario: a settlement that fails on chain never delivers", async () => {
    const t = await running();
    try {
      // Given a transfer that reverts because the nonce was consumed by a tx nothing can be bound to
      t.state.frontRun = true;
      t.state.external = { kind: "unknown" };
      const req = await t.forge();
      // When the agent presents it
      const res = await t.get(req);
      // Then there is no data
      expect(res.status).toBe(402);
      expect(t.handler).not.toHaveBeenCalled();
    } finally {
      await t.close();
    }
  });

  it("Scenario: facilitator restart mid-settlement does not double spend", async () => {
    const t = await running();
    try {
      // Given a payment broadcast and pending when the facilitator dies
      t.state.hold = true;
      const req = await t.forge();
      expect((await t.get(req)).status).toBe(402);
      expect(t.state.prepared).toHaveLength(1);
      t.service.stop();
      // When a fresh service instance starts on the same database and recovers pending payments
      const restarted = new FacilitatorService(t.svc, { policies: t.policies, settlementWaitMs: 20, leaseSeconds: 3 });
      for (const row of restarted.store.pending()) await restarted.recover(row.id);
      // Then no second transfer is prepared; once the chain confirms, the payment settles once
      expect(t.state.prepared).toHaveLength(1);
      t.state.hold = false;
      for (const row of restarted.store.pending()) await restarted.recover(row.id);
      expect(t.db.raw.prepare("SELECT status FROM x402_payments").get()).toEqual({ status: "settled" });
      expect(t.state.prepared).toHaveLength(1);
      // And the agent's retry against the restarted instance gets one delivery claim and a replay gets none
      expect(restarted.claim(req, MERCHANT_ID).success).toBe(true);
      expect(restarted.claim(req, MERCHANT_ID).success).toBe(false);
    } finally {
      await t.close();
    }
  });
});
