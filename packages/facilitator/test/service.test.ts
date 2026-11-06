import { describe, it, expect, vi } from "vitest";
import { FacilitatorService } from "../src/service.js";
import { Db, RelayerService } from "@quietpay/relayer/core";
import { setup, MERCHANT_ID, nonce } from "./helpers.js";
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
describe("exact EVM facilitator", () => {
  it("verifies without committing payment state or broadcasting", async () => {
    const e = setup();
    expect(
      await e.service.verify(await e.request(), MERCHANT_ID),
    ).toMatchObject({ isValid: true });
    expect(
      e.db.raw.prepare("SELECT COUNT(*) n FROM x402_payments").get(),
    ).toEqual({ n: 0 });
    expect(e.state.sent).toHaveLength(0);
  });
  it("settles once, confirms the exact transfer and prevents completed-payment replay", async () => {
    const e = setup(),
      req = await e.request();
    const paid = await e.service.settle(req, MERCHANT_ID);
    expect(paid.success).toBe(true);
    const claim = e.service.claim(req, MERCHANT_ID);
    expect(claim.success).toBe(true);
    expect(
      e.service.delivery(
        claim.paymentId!,
        claim.leaseToken!,
        MERCHANT_ID,
        "complete",
      ).success,
    ).toBe(true);
    expect((await e.service.settle(req, MERCHANT_ID)).errorReason).toBe(
      "payment_replayed",
    );
    expect(e.state.sent).toHaveLength(1);
  });
  it("rejects concurrent identical redemption while one transfer settles", async () => {
    const e = setup(),
      req = await e.request();
    const results = await Promise.all([
      e.service.settle(req, MERCHANT_ID),
      e.service.settle(req, MERCHANT_ID),
    ]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.some((r) => r.errorReason === "payment_replayed")).toBe(
      true,
    );
    expect(e.state.sent).toHaveLength(1);
  });
  it("rejects mismatched amount, recipient, network, asset, resource and requirements", async () => {
    const e = setup(),
      req = await e.request();
    const candidates = [
      (v: typeof req) => {
        v.paymentPayload.payload.authorization.value = "1";
      },
      (v: typeof req) => {
        v.paymentPayload.payload.authorization.to = e.cfg.router;
      },
      (v: typeof req) => {
        v.paymentPayload.accepted = {
          ...v.paymentPayload.accepted,
          network: "eip155:1",
        };
      },
      (v: typeof req) => {
        v.paymentRequirements = {
          ...v.paymentRequirements,
          asset: e.cfg.router,
        };
      },
      (v: typeof req) => {
        v.paymentPayload.resource = { url: "https://evil.test/v1/quote" };
      },
      (v: typeof req) => {
        v.paymentRequirements = { ...v.paymentRequirements, amount: "1" };
      },
    ];
    for (const change of candidates) {
      const bad = copy(req);
      change(bad);
      expect((await e.service.verify(bad, MERCHANT_ID)).isValid).toBe(false);
    }
    expect(e.state.prepared).toHaveLength(0);
  });
  it("rejects expired/future windows, wrong signatures, used nonces and insufficient funds", async () => {
    const e = setup(),
      req = await e.request();
    for (const change of [
      (v: typeof req) => {
        v.paymentPayload.payload.authorization.validBefore = String(
          e.clock.t - 1,
        );
      },
      (v: typeof req) => {
        v.paymentPayload.payload.authorization.validAfter = String(
          e.clock.t + 1,
        );
      },
      (v: typeof req) => {
        v.paymentPayload.payload.authorization.nonce = nonce(9);
      },
    ]) {
      const bad = copy(req);
      change(bad);
      expect((await e.service.verify(bad, MERCHANT_ID)).isValid).toBe(false);
    }
    e.state.balance = 1n;
    expect((await e.service.verify(req, MERCHANT_ID)).invalidReason).toBe(
      "insufficient_funds",
    );
    e.state.balance = 100000n;
    e.state.used.add(req.paymentPayload.payload.authorization.nonce);
    expect((await e.service.verify(req, MERCHANT_ID)).invalidReason).toBe(
      "payment_replayed",
    );
  });
  it("never serves payment success without the matching token Transfer log", async () => {
    const e = setup();
    e.state.missingLog = true;
    const r = await e.service.settle(await e.request(), MERCHANT_ID);
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe("invalid_transaction_state");
  });
  it("shares pause, gas caps, payer caps and hourly loss limits", async () => {
    for (const over of [
      { maxGasLimit: 1n },
      { maxGasPrice: 1n },
      { lossBudgetWei: 1n },
      { payerCap: 1n },
    ]) {
      const e = setup(over);
      expect(
        (await e.service.settle(await e.request(), MERCHANT_ID)).success,
      ).toBe(false);
      expect(e.state.sent).toHaveLength(0);
    }
    const e = setup();
    e.svc.setLocalPaused(true);
    expect(
      (await e.service.settle(await e.request(), MERCHANT_ID)).errorReason,
    ).toBe("relayer_paused");
    expect(e.state.sent).toHaveLength(0);
  });
  it("returns a retryable pending hash on a slow receipt without executing another transfer", async () => {
    const e = setup({}, { waitMs: 5 });
    e.state.never = true;
    const req = await e.request();
    const r = await e.service.settle(req, MERCHANT_ID);
    expect(r).toMatchObject({
      success: false,
      errorReason: "settlement_pending",
    });
    expect(r.transaction).not.toBe("");
    expect((await e.service.settle(req, MERCHANT_ID)).errorReason).toBe(
      "settlement_pending",
    );
    expect(e.state.sent).toHaveLength(1);
    e.state.release?.();
    await new Promise((r) => setTimeout(r, 0));
    expect((await e.service.settle(req, MERCHANT_ID)).success).toBe(true);
  });
  it("recovers uncertain sends after reopening the shared database", async () => {
    const e = setup();
    e.state.hold = true;
    e.state.broadcastFails = true;
    const req = await e.request();
    const r = await e.service.settle(req, MERCHANT_ID);
    expect(r.errorReason).toBe("settlement_pending");
    const db = new Db(e.db.raw.serialize()),
      relayer = new RelayerService({
        cfg: e.cfg,
        db,
        chain: e.chain,
        now: () => e.clock.t,
      });
    const recovered = new FacilitatorService(relayer, { policies: e.policies });
    const row = recovered.store.pending()[0]!;
    e.state.hold = false;
    await recovered.recover(row.id);
    expect(recovered.store.get(row.id)?.status).toBe("settled");
    expect(e.state.prepared).toHaveLength(1);
    db.close();
  });
  it("keeps pending agent reservations counted after an hour", async () => {
    const e = setup({ lossBudgetWei: 150000000000000n });
    e.state.hold = true;
    await e.service.settle(await e.request(), MERCHANT_ID);
    e.clock.t += 3601;
    const second = await e.service.settle(await e.request(2), MERCHANT_ID);
    expect(second.errorReason).toBe("budget_exceeded");
    expect(e.state.sent).toHaveLength(1);
  });
  it("allows only one delivery lease and one failed-delivery retry", async () => {
    const e = setup(),
      req = await e.request();
    await e.service.settle(req, MERCHANT_ID);
    const first = e.service.claim(req, MERCHANT_ID);
    expect(first.success).toBe(true);
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(false);
    expect(
      e.service.delivery(first.paymentId!, "wrong", MERCHANT_ID, "release")
        .success,
    ).toBe(false);
    expect(
      e.service.delivery(
        first.paymentId!,
        first.leaseToken!,
        nonce(999),
        "release",
      ).success,
    ).toBe(false);
    expect(
      e.service.delivery(
        first.paymentId!,
        first.leaseToken!,
        MERCHANT_ID,
        "release",
      ).success,
    ).toBe(true);
    const second = e.service.claim(req, MERCHANT_ID);
    expect(second.success).toBe(true);
    e.service.delivery(
      second.paymentId!,
      second.leaseToken!,
      MERCHANT_ID,
      "release",
    );
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(false);
  });
  it("recovers an expired lease but never exceeds two delivery attempts", async () => {
    const e = setup(),
      req = await e.request();
    await e.service.settle(req, MERCHANT_ID);
    const first = e.service.claim(req, MERCHANT_ID);
    e.clock.t += 4;
    expect(
      e.service.delivery(
        first.paymentId!,
        first.leaseToken!,
        MERCHANT_ID,
        "complete",
      ).success,
    ).toBe(false);
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(true);
    e.clock.t += 4;
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(false);
  });
  it("uses bounded same-nonce replacements without double-reserving gas", async () => {
    const e = setup({ pendingRetrySeconds: 5, maxReplacements: 1 });
    e.state.hold = true;
    await e.service.settle(await e.request(), MERCHANT_ID);
    const row = e.service.store.pending()[0]!;
    e.clock.t += 6;
    await e.service.recover(row.id);
    await new Promise((r) => setTimeout(r, 0));
    const attempts = e.db.attempts(row.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.nonce).toBe(attempts[1]?.nonce);
    expect(attempts[1]?.gas_price).toBe("1125000000");
    expect(e.db.reservedSpend(0)).toBe(135000000000000n);
    e.clock.t += 6;
    await e.service.recover(row.id);
    expect(e.state.prepared).toHaveLength(2);
    e.state.hold = false;
    await vi.waitFor(async () => {
      await e.service.recover(row.id);
      expect(e.service.store.get(row.id)?.status).toBe("settled");
    });
    expect(e.db.spentSince(0)).toBe(100000000000000n);
  });
  it("renews an active delivery lease without opening a second claim", async () => {
    const e = setup(),
      req = await e.request();
    await e.service.settle(req, MERCHANT_ID);
    const lease = e.service.claim(req, MERCHANT_ID);
    e.clock.t += 2;
    expect(
      e.service.delivery(
        lease.paymentId!,
        lease.leaseToken!,
        MERCHANT_ID,
        "renew",
      ).success,
    ).toBe(true);
    e.clock.t += 2;
    expect(e.service.claim(req, MERCHANT_ID).success).toBe(false);
    expect(e.svc.metrics().agentPayments).toMatchObject({ settled: 1 });
  });
});
