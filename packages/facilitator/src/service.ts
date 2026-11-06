import { ZodError } from "zod";
import { randomUUID } from "node:crypto";
import {
  keccak256,
  stringToHex,
  recoverTypedDataAddress,
  type Hex,
} from "viem";
import {
  FacilitatorRequest,
  X402Policy,
  buildAgentAuthorization,
  type X402VerifyResponse,
  type X402SettleResponse,
  type DeliveryClaim,
} from "@quietpay/shared";
import {
  type ExternalSettlement,
  type RelayerService,
  type TransferArgs,
  type TxReceipt,
} from "@quietpay/relayer/core";
import { PaymentStore, type PaymentRow } from "./store.js";

/** A tx that used the agent's authorization without us must be this many blocks deep before we deliver. */
export const EXTERNAL_SETTLEMENT_CONFIRMATIONS = 2;
/** A nonce reported used with no visible tx for this long is parked as `unresolved` instead of retried. */
const UNRESOLVED_AFTER_SECONDS = 900;

export class PaymentError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export interface FacilitatorOptions {
  policies: X402Policy[];
  settlementWaitMs?: number;
  leaseSeconds?: number;
  log?: (message: string, details?: Record<string, unknown>) => void;
}
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fingerprint = (req: FacilitatorRequest) =>
  keccak256(
    stringToHex(
      JSON.stringify({
        resource: new URL(req.paymentPayload.resource.url).href,
        authorization: Object.fromEntries(
          Object.entries(req.paymentPayload.payload.authorization).map(
            ([k, v]) => [k, v.startsWith("0x") ? v.toLowerCase() : v],
          ),
        ),
        signature: req.paymentPayload.payload.signature.toLowerCase(),
      }),
    ),
  );
export class FacilitatorService {
  readonly store: PaymentStore;
  readonly policies: Map<string, X402Policy>;
  readonly waitMs: number;
  readonly leaseSeconds: number;
  private readonly inflight = new Set<string>();
  private readonly tracking = new Map<string, Promise<void>>();
  private readonly recovering = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private readonly log: NonNullable<FacilitatorOptions["log"]>;
  constructor(
    readonly relayer: RelayerService,
    options: FacilitatorOptions,
  ) {
    this.store = new PaymentStore(relayer.db);
    this.policies = new Map();
    this.waitMs = options.settlementWaitMs ?? 5000;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.log = options.log ?? (() => undefined);
    if (
      this.waitMs < 0 ||
      this.waitMs > 60000 ||
      this.leaseSeconds < 3 ||
      this.leaseSeconds > 300
    )
      throw new Error("Invalid settlement wait or delivery lease");
    for (const value of options.policies) {
      const policy = X402Policy.parse(value),
        r = policy.requirements,
        url = new URL(policy.resource.url).href;
      if (
        r.network !== `eip155:${relayer.cfg.chainId}` ||
        !eq(r.asset, relayer.cfg.usdt) ||
        eq(r.payTo, relayer.cfg.router) ||
        /^0x0{40}$/i.test(r.payTo) ||
        r.extra.name !== relayer.cfg.tokenDomain.name ||
        r.extra.version !== relayer.cfg.tokenDomain.version ||
        r.extra.paymentFlow !== "upfront"
      )
        throw new Error("Policy does not match this USDT facilitator");
      if (this.policies.has(url)) throw new Error("Duplicate paid resource");
      this.policies.set(url, policy);
    }
    if (!this.policies.size)
      throw new Error("At least one paid resource is required");
    const binding = JSON.stringify([
      relayer.cfg.chainId,
      relayer.cfg.usdt.toLowerCase(),
      relayer.chain.relayerAddress.toLowerCase(),
    ]);
    const existing = relayer.db.getSetting("x402_scope");
    if (existing && existing !== binding)
      throw new Error(
        "Payment database belongs to a different chain, token or gas wallet",
      );
    relayer.db.setSetting("x402_scope", binding);
  }
  private inspect(value: FacilitatorRequest, merchant: string) {
    const req = FacilitatorRequest.parse(value),
      payload = req.paymentPayload,
      auth = payload.payload.authorization;
    const policy = this.policies.get(new URL(payload.resource.url).href);
    if (!policy || !eq(policy.merchantId, merchant))
      throw new PaymentError("invalid_payment_requirements");
    const matches = (r: typeof req.paymentRequirements) =>
      r.scheme === policy.requirements.scheme &&
      r.network === policy.requirements.network &&
      eq(r.asset, policy.requirements.asset) &&
      eq(r.payTo, policy.requirements.payTo) &&
      r.amount === policy.requirements.amount &&
      r.maxTimeoutSeconds === policy.requirements.maxTimeoutSeconds &&
      r.extra.name === policy.requirements.extra.name &&
      r.extra.version === policy.requirements.extra.version &&
      (r.extra.assetTransferMethod ?? "eip3009") ===
        (policy.requirements.extra.assetTransferMethod ?? "eip3009") &&
      r.extra.paymentFlow === policy.requirements.extra.paymentFlow;
    if (!matches(req.paymentRequirements) || !matches(payload.accepted))
      throw new PaymentError("invalid_payment_requirements");
    if (auth.value !== policy.requirements.amount)
      throw new PaymentError(
        "invalid_exact_evm_payload_authorization_value_mismatch",
      );
    if (!eq(auth.to, policy.requirements.payTo))
      throw new PaymentError("invalid_exact_evm_payload_recipient_mismatch");
    const id = keccak256(
      stringToHex(
        JSON.stringify([
          this.relayer.cfg.chainId,
          this.relayer.cfg.usdt.toLowerCase(),
          auth.from.toLowerCase(),
          auth.nonce.toLowerCase(),
        ]),
      ),
    );
    return { req, policy, auth, id, fingerprint: fingerprint(req) };
  }
  private args(req: FacilitatorRequest): TransferArgs {
    const a = req.paymentPayload.payload.authorization;
    return {
      from: a.from as Hex,
      to: a.to as Hex,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce as Hex,
      signature: req.paymentPayload.payload.signature as Hex,
    };
  }
  async verify(
    value: FacilitatorRequest,
    merchant: string,
  ): Promise<X402VerifyResponse> {
    try {
      const { req, auth, id } = this.inspect(value, merchant),
        now = BigInt(this.relayer.now()),
        before = BigInt(auth.validBefore),
        after = BigInt(auth.validAfter);
      if (this.store.get(id)) throw new PaymentError("payment_replayed");
      if (after >= now)
        throw new PaymentError(
          "invalid_exact_evm_payload_authorization_valid_after",
        );
      if (
        before <= now ||
        before <= after ||
        before - now > BigInt(req.paymentRequirements.maxTimeoutSeconds)
      )
        throw new PaymentError(
          "invalid_exact_evm_payload_authorization_valid_before",
        );
      const td = buildAgentAuthorization({
        ...this.args(req),
        chainId: this.relayer.cfg.chainId,
        token: this.relayer.cfg.usdt,
      });
      let signer: string;
      try {
        signer = await recoverTypedDataAddress({
          ...td,
          signature: req.paymentPayload.payload.signature as Hex,
        });
      } catch {
        throw new PaymentError("invalid_exact_evm_payload_signature");
      }
      if (!eq(signer, auth.from))
        throw new PaymentError("invalid_exact_evm_payload_signature");
      if (
        (await this.relayer.chain.getTokenBalance(auth.from as Hex)) <
        BigInt(auth.value)
      )
        throw new PaymentError("insufficient_funds");
      if (
        await this.relayer.chain.authorizationUsed(
          auth.from as Hex,
          auth.nonce as Hex,
        )
      )
        throw new PaymentError("payment_replayed");
      try {
        await this.relayer.chain.simulateTransfer(this.args(req));
      } catch {
        throw new PaymentError("invalid_transaction_state");
      }
      return { isValid: true, payer: auth.from };
    } catch (error) {
      return {
        isValid: false,
        invalidReason:
          error instanceof PaymentError
            ? error.reason
            : error instanceof ZodError
              ? "invalid_payload"
              : "unexpected_verify_error",
      };
    }
  }
  private newRow(data: ReturnType<FacilitatorService["inspect"]>): PaymentRow {
    const { req, policy, auth, id } = data;
    return {
      id,
      payer: auth.from.toLowerCase(),
      nonce: auth.nonce.toLowerCase(),
      merchant_id: policy.merchantId.toLowerCase(),
      resource: new URL(policy.resource.url).href,
      pay_to: auth.to.toLowerCase(),
      amount: auth.value,
      fingerprint: data.fingerprint,
      request: JSON.stringify(req),
      status: "settling",
      tx_hash: null,
      error_reason: null,
      created_at: this.relayer.now(),
      delivered_at: null,
      delivery_attempts: 0,
      lease_token: null,
      lease_until: null,
    };
  }
  /**
   * The nonce was already used before we sent anything. Record the payment and let the external-settlement
   * check decide: a plain transfer that paid exactly this authorization settles it (once deep enough), a
   * cancelled one fails, anything unbindable is parked as unresolved. Returns false (nothing recorded) when
   * the nonce turns out not to be used, so the caller answers payment_replayed as before.
   */
  private adoptExternal(
    data: ReturnType<FacilitatorService["inspect"]>,
  ): Promise<boolean> {
    return this.relayer.sendLock.run(async () => {
      if (this.store.get(data.id)) return false;
      const row = this.newRow(data);
      this.store.insert(row);
      if ((await this.resolveExternal(row)) !== "none") return true;
      this.relayer.db.raw.prepare("DELETE FROM x402_payments WHERE id=?").run(row.id);
      return false;
    });
  }
  private result(id: string): X402SettleResponse {
    const row = this.store.get(id)!;
    const base = {
      payer: row.payer,
      transaction: row.tx_hash ?? "",
      network: `eip155:${this.relayer.cfg.chainId}`,
    };
    if (
      row.status === "settled" &&
      row.delivered_at === null &&
      row.delivery_attempts < 2
    )
      return { ...base, success: true };
    if (row.status === "settling")
      return { ...base, success: false, errorReason: "settlement_pending" };
    return {
      ...base,
      success: false,
      errorReason:
        row.status === "settled"
          ? "payment_replayed"
          : (row.error_reason ?? "unexpected_settle_error"),
    };
  }
  async settle(
    value: FacilitatorRequest,
    merchant: string,
  ): Promise<X402SettleResponse> {
    const failed = (reason: string): X402SettleResponse => {
      this.relayer.recordRejection(reason);
      return {
        success: false,
        errorReason: reason,
        transaction: "",
        network: `eip155:${this.relayer.cfg.chainId}`,
      };
    };
    let data: ReturnType<FacilitatorService["inspect"]>;
    try {
      data = this.inspect(value, merchant);
    } catch (e) {
      return failed(e instanceof PaymentError ? e.reason : "invalid_payload");
    }
    const { req, policy, auth, id } = data;
    if (this.inflight.has(id)) return failed("payment_replayed");
    const existing = this.store.get(id);
    if (existing) {
      if (
        existing.fingerprint !== data.fingerprint ||
        !eq(existing.merchant_id, merchant)
      )
        return failed("payment_replayed");
      if (existing.status === "settling") await this.recover(id);
      return this.result(id);
    }
    this.inflight.add(id);
    try {
      const verified = await this.verify(req, merchant);
      if (!verified.isValid) {
        // A used nonce may be a front-run: someone else submitted this very authorization and the payee was paid.
        if (
          verified.invalidReason === "payment_replayed" &&
          (await this.adoptExternal(data))
        )
          return this.result(id);
        return failed(verified.invalidReason!);
      }
      await this.relayer.sendLock.run(async () => {
        if (this.store.get(id)) throw new PaymentError("payment_replayed");
        const row = this.newRow(data);
        this.store.insert(row);
        try {
          await this.sendLocked(row);
        } catch (error) {
          // Refused before anything was sent (cap, expiry, revert limit) but the authorization may have been used by
          // someone else meanwhile: then the payee was paid and this must not become a plain failure.
          if (
            this.relayer.db.attempts(id).length === 0 &&
            (await this.resolveExternal(row)) !== "none"
          )
            return;
          this.store.failed(
            id,
            error instanceof PaymentError
              ? error.reason
              : "unexpected_settle_error",
          );
        }
      });
      const row = this.store.get(id)!;
      if (row.tx_hash && row.status === "settling") {
        const tracking = this.track(id, row.tx_hash as Hex);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            tracking,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, this.waitMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return this.result(id);
    } catch (error) {
      return failed(
        error instanceof PaymentError
          ? error.reason
          : "unexpected_settle_error",
      );
    } finally {
      this.inflight.delete(id);
    }
  }
  private budget(gas: bigint, price: bigint, additional: bigint) {
    const { cfg, db, now } = this.relayer;
    if (
      gas > cfg.maxGasLimit ||
      (cfg.maxGasPrice !== null && price > cfg.maxGasPrice)
    )
      throw new PaymentError("relayer_paused");
    if (db.reservedSpend(now() - 3600) + additional > cfg.lossBudgetWei)
      throw new PaymentError("budget_exceeded");
  }
  private async sendLocked(row: PaymentRow) {
    const svc = this.relayer,
      req = FacilitatorRequest.parse(JSON.parse(row.request));
    if (svc.localPaused || (await svc.chain.isPaused()))
      throw new PaymentError("relayer_paused");
    if (svc.db.payerVolume(row.payer, svc.now() - 86400) > svc.cfg.payerCap)
      throw new PaymentError("budget_exceeded");
    // Same per-wallet limit as checkout: a wallet whose transactions keep reverting burns the shared gas budget.
    if (svc.db.revertStats(row.payer, svc.now() - 86400).count >= svc.cfg.maxRevertsPerDay)
      throw new PaymentError("budget_exceeded");
    if (
      BigInt(req.paymentPayload.payload.authorization.validBefore) <=
      BigInt(svc.now())
    )
      throw new PaymentError(
        "invalid_exact_evm_payload_authorization_valid_before",
      );
    let gas: bigint;
    try {
      gas =
        ((await svc.chain.simulateTransfer(this.args(req))) * 12n + 9n) / 10n;
    } catch {
      // The authorization may already have been used by someone else before we could send (a front-run).
      if ((await this.resolveExternal(row)) !== "none") return;
      throw new PaymentError("invalid_transaction_state");
    }
    const price = await svc.chain.getGasPrice();
    this.budget(gas, price, gas * price);
    if (svc.localPaused) throw new PaymentError("relayer_paused");
    const tx = await svc.chain.prepareTransfer(this.args(req), gas, price);
    svc.db.saveAttempt(
      {
        hash: tx.hash,
        raw: tx.raw,
        order_id: row.id,
        nonce: tx.nonce,
        gas: gas.toString(),
        gas_price: price.toString(),
        sent_at: svc.now(),
        replacement: 0,
      },
      "x402_payments",
    );
    svc.recordRelay();
    try {
      if (!svc.localPaused) await svc.chain.broadcast(tx.raw);
    } catch {
      this.log("agent broadcast uncertain; saved for recovery", {
        payment: row.id,
      });
    }
  }
  /**
   * Our own send failed or reverted. Before calling that a failure, check whether someone else already used the
   * signed authorization (a front-run): if a plain `transferWithAuthorization` to the token paid exactly this
   * payer, payee and amount under this nonce, the payee WAS paid and the payment is settled by that tx once it
   * is deep enough. A used nonce that cannot be bound to a payment is parked as `unresolved` (never delivered).
   * Returns "none" when the nonce is unused, so the caller records the ordinary failure.
   */
  private async resolveExternal(
    row: PaymentRow,
  ): Promise<"none" | "pending" | "settled" | "failed" | "unresolved"> {
    const svc = this.relayer;
    let used: boolean;
    let outcome: ExternalSettlement;
    try {
      used = await svc.chain.authorizationUsed(row.payer as Hex, row.nonce as Hex);
      if (!used) return "none";
      outcome = await svc.chain.findExternalSettlement(
        this.args(FacilitatorRequest.parse(JSON.parse(row.request))),
      );
    } catch {
      return "pending"; // RPC trouble: stay settling, the recovery sweep tries again
    }
    if (outcome.kind === "cancelled") {
      this.store.failed(row.id, "authorization_cancelled");
      return "failed";
    }
    if (outcome.kind === "matched") {
      const ours = new Set(svc.db.attempts(row.id).map((a) => a.hash.toLowerCase()));
      if (!ours.has(outcome.hash.toLowerCase())) {
        if (outcome.confirmations < EXTERNAL_SETTLEMENT_CONFIRMATIONS) return "pending";
        if (this.store.settledExternal(row.id, outcome)) return "settled";
      }
    } else if (
      outcome.kind === "none" &&
      svc.now() - row.created_at < UNRESOLVED_AFTER_SECONDS
    ) {
      return "pending"; // used, but the tx is not visible yet (node lag, reorg): give it time
    }
    this.store.unresolved(row.id);
    return "unresolved";
  }
  private async finish(id: string, hash: Hex, receipt: TxReceipt) {
    const svc = this.relayer,
      row = this.store.get(id);
    if (!row || row.status !== "settling") return;
    const matches = receipt.transfers?.filter(
      (log) =>
        eq(log.token, svc.cfg.usdt) &&
        eq(log.from, row.payer) &&
        eq(log.to, row.pay_to) &&
        log.value === BigInt(row.amount),
    );
    const success = receipt.status === "success" && matches?.length === 1;
    svc.db.raw.transaction(() => {
      for (const attempt of svc.db.attempts(id))
        svc.db.raw
          .prepare("DELETE FROM spend WHERE tx_hash=?")
          .run(attempt.hash);
      // Our tx burned gas whether or not it paid, so it always counts against the loss budget.
      svc.db.recordSpend(
        hash,
        svc.now(),
        receipt.gasUsed * receipt.effectiveGasPrice,
      );
      if (success)
        svc.db.raw
          .prepare(
            "UPDATE x402_payments SET status='settled',tx_hash=?,error_reason=NULL WHERE id=?",
          )
          .run(hash, id);
    })();
    if (success) return;
    // Only a REVERTED attempt can mean someone else used the authorization first. If our own tx succeeded
    // but did not pay as signed, our tx consumed the nonce: that is a plain failure, never an external settlement.
    if (receipt.status !== "success" && (await this.resolveExternal(row)) !== "none") return;
    // A revert counts against the payer only if it happened inside the signed window: a tx the relayer held back
    // until after validBefore expired through no fault of the payer (same exemption as checkout). x402 reverts are
    // not "first-time payer" reverts either: that pool belongs to checkout's new-payer loss share.
    const validBefore = BigInt(FacilitatorRequest.parse(JSON.parse(row.request)).paymentPayload.payload.authorization.validBefore);
    if (receipt.status !== "success" && BigInt(svc.now()) < validBefore)
      svc.db.recordRevert({
        txHash: hash,
        orderId: row.id,
        payer: row.payer,
        ts: svc.now(),
        wei: receipt.gasUsed * receipt.effectiveGasPrice,
        firstTime: false,
      });
    svc.db.raw
      .prepare(
        "UPDATE x402_payments SET status='failed',tx_hash=?,error_reason='invalid_transaction_state' WHERE id=? AND status='settling'",
      )
      .run(hash, id);
  }
  private track(id: string, hash: Hex): Promise<void> {
    const current = this.tracking.get(id);
    if (current) return current;
    const work = this.relayer.chain
      .waitForReceipt(hash)
      .then((receipt) => this.finish(id, hash, receipt))
      .catch(() =>
        this.log("agent receipt pending; monitor will retry", { payment: id }),
      )
      .finally(() => this.tracking.delete(id));
    this.tracking.set(id, work);
    return work;
  }
  async recover(id: string) {
    if (
      this.recovering.has(id) ||
      this.inflight.has(id) ||
      this.tracking.has(id)
    )
      return;
    this.recovering.add(id);
    try {
      const row = this.store.get(id);
      if (!row || row.status !== "settling") return;
      const svc = this.relayer,
        attempts = svc.db.attempts(id),
        latest = attempts.at(-1);
      for (const attempt of attempts) {
        const receipt = await svc.chain.getReceipt(attempt.hash as Hex);
        if (receipt) {
          await this.finish(id, attempt.hash as Hex, receipt);
          return;
        }
      }
      await svc.sendLock.run(async () => {
        if (
          this.store.get(id)?.status !== "settling" ||
          svc.localPaused ||
          (await svc.chain.isPaused())
        )
          return;
        if (!latest) {
          // Nothing of ours was ever sent (for example a payment adopted from a foreign tx that was still shallow):
          // a used nonce must be resolved against the chain BEFORE the cap and expiry checks in sendLocked, which would
          // otherwise fail a payment the payee already received.
          if ((await this.resolveExternal(row)) !== "none") return;
          try {
            await this.sendLocked(row);
          } catch (e) {
            this.store.failed(
              id,
              e instanceof PaymentError ? e.reason : "unexpected_settle_error",
            );
          }
          return;
        }
        let raw = latest.raw as Hex;
        const req = FacilitatorRequest.parse(JSON.parse(row.request));
        if (
          svc.now() - latest.sent_at >= svc.cfg.pendingRetrySeconds &&
          latest.replacement < svc.cfg.maxReplacements &&
          BigInt(req.paymentPayload.payload.authorization.validBefore) >
            BigInt(svc.now())
        ) {
          const gas = BigInt(latest.gas),
            price = (BigInt(latest.gas_price) * 1125n + 999n) / 1000n;
          try {
            this.budget(gas, price, gas * (price - BigInt(latest.gas_price)));
            const tx = await svc.chain.prepareTransfer(
              this.args(req),
              gas,
              price,
              latest.nonce,
            );
            svc.db.saveAttempt(
              {
                hash: tx.hash,
                raw: tx.raw,
                order_id: id,
                nonce: latest.nonce,
                gas: gas.toString(),
                gas_price: price.toString(),
                sent_at: svc.now(),
                replacement: latest.replacement + 1,
              },
              "x402_payments",
            );
            raw = tx.raw;
          } catch (e) {
            if (!(e instanceof PaymentError)) throw e;
          }
        }
        try {
          if (!svc.localPaused) await svc.chain.broadcast(raw);
        } catch {}
      });
      const updated = this.store.get(id);
      if (updated?.status === "settling" && updated.tx_hash)
        void this.track(id, updated.tx_hash as Hex);
    } finally {
      this.recovering.delete(id);
    }
  }
  private deliveryRow(value: FacilitatorRequest, merchant: string) {
    const info = this.inspect(value, merchant),
      row = this.store.get(info.id);
    if (
      !row ||
      row.fingerprint !== info.fingerprint ||
      !eq(row.merchant_id, merchant)
    )
      throw new PaymentError("payment_replayed");
    return row;
  }
  claim(value: FacilitatorRequest, merchant: string): DeliveryClaim {
    const row = this.deliveryRow(value, merchant),
      now = this.relayer.now(),
      token = randomUUID();
    const changed = this.relayer.db.raw
      .prepare(
        `UPDATE x402_payments SET lease_token=?,lease_until=?,delivery_attempts=delivery_attempts+1
      WHERE id=? AND status='settled' AND delivered_at IS NULL AND delivery_attempts<2 AND (lease_token IS NULL OR lease_until<=?)`,
      )
      .run(token, now + this.leaseSeconds, row.id, now);
    return changed.changes === 1
      ? {
          success: true,
          paymentId: row.id,
          leaseToken: token,
          leaseSeconds: this.leaseSeconds,
        }
      : { success: false, errorReason: "payment_replayed" };
  }
  delivery(
    id: string,
    leaseToken: string,
    merchant: string,
    action: "complete" | "release" | "renew",
  ) {
    const row = this.store.get(id);
    if (!row || !eq(row.merchant_id, merchant)) return { success: false };
    const now = this.relayer.now();
    const operation =
      action === "complete"
        ? "delivered_at=?,lease_token=NULL,lease_until=NULL"
        : action === "release"
          ? "lease_token=NULL,lease_until=NULL"
          : "lease_until=?";
    const values =
      action === "release"
        ? []
        : [action === "complete" ? now : now + this.leaseSeconds];
    const changed = this.relayer.db.raw
      .prepare(
        `UPDATE x402_payments SET ${operation} WHERE id=? AND lease_token=? AND lease_until>? AND delivered_at IS NULL AND status='settled'`,
      )
      .run(...values, id, leaseToken, now);
    return { success: changed.changes === 1 };
  }
  start(intervalMs = this.relayer.cfg.pendingRetrySeconds * 1000) {
    if (this.timer) return;
    this.recoverPending();
    this.timer = setInterval(() => this.recoverPending(), intervalMs);
    this.timer.unref();
  }
  private recoverPending() {
    for (const row of this.store.pending())
      void this.recover(row.id).catch((e) =>
        this.log("agent recovery failed", {
          payment: row.id,
          error: String(e),
        }),
      );
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
