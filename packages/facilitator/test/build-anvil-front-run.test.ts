import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  encodeX402Header,
  PAYMENT_SIGNATURE,
  type FacilitatorRequest,
} from "@quietpay/shared";
import { buildServer } from "@quietpay/relayer/core";
import { registerFacilitator } from "../src/server.js";
import { buildPaidApi } from "../../../apps/paid-api/src/app.js";
import { chainReady, deployWorld, startAnvil, type World } from "./build-anvil-kit.js";

// W6 independent real-chain front-run tests. Own anvil, own token, full path: paid API -> facilitator HTTP -> chain.
//  1. A third party submits the agent's authorization first: our tx reverts, the payment ends settled with the
//     foreign hash and the protected data is delivered exactly once.
//  2. The payer cancels the authorization (AuthorizationCanceled): the payment ends failed, no data is delivered.

describe.skipIf(!chainReady)("W6 front-run and cancel on a real chain", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let plain: World;
  let cancelable: World;
  let cancelAnvil: Awaited<ReturnType<typeof startAnvil>>;
  beforeAll(async () => {
    anvil = await startAnvil();
    plain = await deployWorld(anvil.rpc, anvil.call);
    cancelAnvil = await startAnvil();
    cancelable = await deployWorld(cancelAnvil.rpc, cancelAnvil.call, true);
  }, 120000);
  afterAll(() => {
    anvil?.stop();
    cancelAnvil?.stop();
  });

  async function stack(w: World) {
    const s = w.makeServices({ apiKeys: new Map([["test-key", w.merchant]]) }, { waitMs: 300 });
    const fac = buildServer(s.svc);
    await registerFacilitator(fac, s.facilitator);
    const facilitatorUrl = await fac.listen({ host: "127.0.0.1", port: 0 });
    const handler = vi.fn(() => ({ protected: "paid-data" }));
    const api = buildPaidApi({
      policies: s.policies,
      facilitatorUrl,
      apiKey: "test-key",
      handlers: { "/v1/quote": handler },
    });
    const apiUrl = await api.listen({ host: "127.0.0.1", port: 0 });
    const policy = s.policies.find((p) => new URL(p.resource.url).pathname === "/v1/quote")!;
    const pay = (req: FacilitatorRequest) =>
      fetch(apiUrl + "/v1/quote", {
        headers: { [PAYMENT_SIGNATURE]: encodeX402Header(req.paymentPayload) },
      });
    const row = (nonce: string) =>
      s.db.raw.prepare("SELECT * FROM x402_payments WHERE nonce=?").get(nonce) as Record<string, any>;
    const close = async () => {
      await api.close();
      await fac.close();
      s.close();
    };
    return { ...s, handler, policy, pay, row, close, facilitatorUrl };
  }
  const mineSome = async (w: World) => {
    for (let i = 0; i < 3; i++) await w.call("evm_mine");
  };

  it("Scenario: foreign tx wins the race -> settled with the foreign hash, data delivered exactly once", async () => {
    const w = plain;
    const t = await stack(w);
    const payer = await w.newPayer();
    const req = await w.sign({ payer, policy: t.policy, nonceN: 0xf1 });
    const nonce = req.paymentPayload.payload.authorization.nonce;
    await w.call("evm_setAutomine", [false]);
    try {
      // Given the agent pays; our relay tx sits in the mempool and the API answers 402 settlement_pending
      const first = await t.pay(req);
      expect(first.status).toBe(402);
      expect(t.handler).not.toHaveBeenCalled();
      // When a third party submits the same authorization with a higher tip and the block is mined
      const attackHash = await w.frontRun(req);
      await mineSome(w);
      await vi.waitFor(
        async () => {
          await t.facilitator.recover(t.row(nonce).id);
          expect(t.row(nonce).status).toBe("settled");
        },
        { timeout: 20000, interval: 200 },
      );
      // Then the payment is settled by the foreign hash, our own tx reverted, the payee got paid once
      expect(String(t.row(nonce).tx_hash).toLowerCase()).toBe(attackHash.toLowerCase());
      const ours = t.db.attempts(t.row(nonce).id);
      expect(ours).toHaveLength(1);
      expect((await w.pub.getTransactionReceipt({ hash: ours[0]!.hash as `0x${string}` })).status).toBe("reverted");
      expect(await w.balance(w.payTo)).toBe(BigInt(t.policy.requirements.amount));
      // and the client's retry of the SAME header receives the data exactly once
      const ok = await t.pay(req);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ protected: "paid-data" });
      await vi.waitFor(() => expect(t.row(nonce).delivered_at).not.toBeNull());
      const replay = await t.pay(req);
      expect(replay.status).toBe(402);
      expect(t.handler).toHaveBeenCalledTimes(1);
      expect(await w.balance(w.payTo)).toBe(BigInt(t.policy.requirements.amount));
    } finally {
      await w.call("evm_setAutomine", [true]);
      await t.close();
    }
  }, 90000);

  it("Scenario: two clients race the same front-run payment -> one delivery", async () => {
    const w = plain;
    const t = await stack(w);
    const payer = await w.newPayer();
    const req = await w.sign({ payer, policy: t.policy, nonceN: 0xf2 });
    const nonce = req.paymentPayload.payload.authorization.nonce;
    await w.call("evm_setAutomine", [false]);
    try {
      await t.pay(req);
      await w.frontRun(req);
      await mineSome(w);
      await vi.waitFor(
        async () => {
          await t.facilitator.recover(t.row(nonce).id);
          expect(t.row(nonce).status).toBe("settled");
        },
        { timeout: 20000, interval: 200 },
      );
      const results = await Promise.all([t.pay(req), t.pay(req), t.pay(req)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(t.handler).toHaveBeenCalledTimes(1);
    } finally {
      await w.call("evm_setAutomine", [true]);
      await t.close();
    }
  }, 90000);

  it("Scenario: payer cancels the authorization -> failed, nothing delivered, payee unpaid", async () => {
    const w = cancelable;
    const t = await stack(w);
    const payer = await w.newPayer();
    const req = await w.sign({ payer, policy: t.policy, nonceN: 0xc1 });
    const nonce = req.paymentPayload.payload.authorization.nonce;
    await w.call("evm_setAutomine", [false]);
    try {
      // Given the agent pays and our tx is pending
      const first = await t.pay(req);
      expect(first.status).toBe(402);
      // When the authorization is cancelled with a higher tip before ours is mined
      await w.cancel(payer, nonce);
      await mineSome(w);
      await vi.waitFor(
        async () => {
          await t.facilitator.recover(t.row(nonce).id);
          expect(t.row(nonce).status).toBe("failed");
        },
        { timeout: 20000, interval: 200 },
      );
      // Then it is failed with the cancel reason, and no data goes out, ever
      expect(t.row(nonce).error_reason).toBe("authorization_cancelled");
      expect(await w.balance(w.payTo)).toBe(0n);
      const retry = await t.pay(req);
      expect(retry.status).toBe(402);
      expect(t.handler).not.toHaveBeenCalled();
      expect(t.facilitator.claim(req, w.merchant).success).toBe(false);
      expect(t.facilitator.paymentStatus(payer.address, nonce)).toEqual({ status: "failed" });
    } finally {
      await w.call("evm_setAutomine", [true]);
      await t.close();
    }
  }, 90000);
});
