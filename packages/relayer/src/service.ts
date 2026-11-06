import { randomBytes, randomUUID } from "node:crypto";
import { formatUnits, isAddress, type Hex } from "viem";
import {
  QuietpayError,
  checkAuthWindow,
  computePayNonce,
  recoverCheckoutSigner,
  token as tokenFacts,
  type CreateOrderRequest,
  type ErrorCode,
  type MetricsResponse,
  type Order,
  type RelayPayRequest,
  type RelayPayResponse,
} from "@quietpay/shared";
import type { WebhookEvent } from "@quietpay/shared/webhook";
import { rowToOrder, type Db, type OrderRow } from "./db.js";
import type { ChainPort, PayArgs, TxReceipt } from "./chain.js";
import type { Config } from "./config.js";
import { RateLimiter } from "./ratelimit.js";

const HOUR = 3600;
const DAY = 86_400;
const ZERO = "0x0000000000000000000000000000000000000000";

export interface ServiceDeps {
  cfg: Config;
  db: Db;
  chain: ChainPort;
  now?: () => number; // unix seconds
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn);
    this.tail = r.catch(() => undefined);
    return r;
  }
}

export class RelayerService {
  readonly cfg: Config;
  readonly db: Db;
  readonly chain: ChainPort;
  readonly now: () => number;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly ipLimiter: RateLimiter;
  private readonly payerLimiter: RateLimiter;
  private readonly merchantLimiter: RateLimiter;
  private balanceWei: bigint | null = null;
  private balanceLow = false;
  private monitor: NodeJS.Timeout | null = null;
  private readonly orderLimiter: RateLimiter;
  private readonly sendLock = new Mutex();
  private relayed = 0;
  private readonly rejected = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<RelayPayResponse>>();
  private readonly recovering = new Set<string>();
  private readonly tracking = new Set<string>();

  constructor(d: ServiceDeps) {
    this.cfg = d.cfg;
    this.db = d.db;
    this.chain = d.chain;
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = d.log ?? (() => undefined);
    this.payerLimiter = new RateLimiter(d.cfg.rateLimitPerMinute, 60_000, () => this.now() * 1000);
    this.merchantLimiter = new RateLimiter(d.cfg.rateLimitPerMinute, 60_000, () => this.now() * 1000);
    this.ipLimiter = new RateLimiter(d.cfg.rateLimitPerMinute, 60_000, () => this.now() * 1000);
    this.orderLimiter = new RateLimiter(Math.max(5, Math.floor(d.cfg.rateLimitPerMinute / 2)), 60_000, () => this.now() * 1000);
  }

  // ------------------------------------------------------------------ admin

  get localPaused(): boolean {
    return this.db.getSetting("paused") === "1";
  }
  setLocalPaused(p: boolean) {
    this.db.setSetting("paused", p ? "1" : "0");
  }

  // ------------------------------------------------------------------ views

  toOrder(row: OrderRow): Order {
    return rowToOrder(row, {
      router: this.cfg.router,
      token: this.cfg.usdt,
      chainId: this.cfg.chainId,
      domain: tokenFacts.eip712Domain,
      explorerBaseUrl: this.cfg.explorerBaseUrl,
    });
  }

  getOrder(id: string): Order {
    const row = this.db.getOrder(id);
    if (!row) throw new QuietpayError("order_not_found");
    return this.toOrder(this.expireIfNeeded(row));
  }

  listOrders(merchantId: string): Order[] {
    return this.db.listOrders(merchantId).map((r) => this.toOrder(this.expireIfNeeded(r)));
  }

  private expireIfNeeded(row: OrderRow): OrderRow {
    if (row.status === "created" && this.now() >= row.expires_at) {
      this.db.setStatus(row.id, "expired");
      return { ...row, status: "expired" };
    }
    return row;
  }

  async health() {
    const paused = this.localPaused || (await this.chain.isPaused());
    return {
      ok: true,
      chainId: this.cfg.chainId,
      router: this.cfg.router,
      token: this.cfg.usdt,
      relayer: this.chain.relayerAddress,
      paused,
      blockNumber: Number(await this.chain.getBlockNumber()),
    };
  }

  metrics(): MetricsResponse {
    const counts = this.db.countByStatus();
    const spent = this.db.spentSince(this.now() - HOUR);
    return {
      balanceWbt: this.balanceWei === null ? null : formatUnits(this.balanceWei, 18),
      lowBalance: this.balanceLow,
      lowBalanceThresholdWbt: formatUnits(this.cfg.lowBalanceWei, 18),
      orders: {
        created: counts.created ?? 0,
        pending: counts.pending ?? 0,
        settled: counts.settled ?? 0,
        failed: counts.failed ?? 0,
        expired: counts.expired ?? 0,
      },
      relayed: this.relayed,
      rejected: Object.fromEntries(this.rejected),
      lossBudget: {
        limitWbtPerHour: formatUnits(this.cfg.lossBudgetWei, 18),
        spentWbtLastHour: formatUnits(spent, 18),
      },
      paused: this.localPaused,
    };
  }

  // ------------------------------------------------------------------ orders

  async createOrder(merchantId: Hex, req: CreateOrderRequest): Promise<Order> {
    const m = await this.chain.getMerchant(merchantId);
    if (m.payout === ZERO) throw new QuietpayError("simulation_failed", "This merchant is not registered.");
    const amount = BigInt(req.amount);
    let fee = this.cfg.relayFee < m.maxRelayFee ? this.cfg.relayFee : m.maxRelayFee;
    if (fee > amount) fee = amount;
    const id = ("0x" + randomBytes(32).toString("hex")) as Hex;
    const created = this.now();
    const row: OrderRow = {
      id,
      merchant_id: merchantId.toLowerCase(),
      amount: amount.toString(),
      fee: fee.toString(),
      payout: m.payout.toLowerCase(),
      status: "created",
      reference: req.reference ?? null,
      webhook_url: req.webhookUrl ?? null,
      nonce: computePayNonce({ merchantId, orderId: id, payout: m.payout, value: amount }),
      payer: null,
      tx_hash: null,
      signature: null,
      valid_after: null,
      valid_before: null,
      failure_code: null,
      created_at: created,
      expires_at: created + (req.expiresInSeconds ?? 900),
      settled_at: null,
    };
    this.db.insertOrder(row);
    return this.toOrder(row);
  }

  // ------------------------------------------------------------------ relay

  private reject(code: ErrorCode, message?: string): never {
    this.rejected.set(code, (this.rejected.get(code) ?? 0) + 1);
    throw new QuietpayError(code, message);
  }

  /**
   * Guard pipeline. Every check runs before anything is broadcast, and the
   * cheapest checks run first so a flood of junk costs the relayer nothing.
   */
  async relayPay(req: RelayPayRequest, ctx: { ip: string }): Promise<RelayPayResponse> {
    const key = JSON.stringify([req.orderId.toLowerCase(), req.signature.toLowerCase(), req.payer.toLowerCase(), req.validAfter, req.validBefore, req.amount]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const work = this.relayPayOnce(req, ctx);
    this.inFlight.set(key, work);
    try { return await work; }
    finally { this.inFlight.delete(key); }
  }

  private async relayPayOnce(req: RelayPayRequest, ctx: { ip: string }): Promise<RelayPayResponse> {
    // 1. rate limit (per client and per order)
    if (!this.ipLimiter.allow(`ip:${ctx.ip}`) || !this.orderLimiter.allow(`order:${req.orderId.toLowerCase()}`)) {
      this.reject("rate_limited");
    }

    // 2. order exists and is not expired
    const found = this.db.getOrder(req.orderId);
    if (!found) this.reject("order_not_found");
    const row = this.expireIfNeeded(found);

    // Idempotency: the same signature for the same order returns the same hash.
    if (row.signature && row.signature.toLowerCase() === req.signature.toLowerCase() && row.tx_hash) {
      return { orderId: row.id as Hex, status: row.status, txHash: row.tx_hash as Hex };
    }
    if (row.status === "settled" || row.status === "pending") this.reject("already_settled");
    if (row.status === "expired") this.reject("order_expired");

    // 3. amount matches
    if (req.amount !== undefined && req.amount !== row.amount) {
      this.reject("amount_mismatch");
    }

    // 4. signature parses, window is valid, and it matches the order's typed data
    const nowS = this.now();
    if (nowS >= req.validBefore) this.reject("order_expired", "Your approval expired. Please try again.");
    const windowErr = checkAuthWindow(req.validAfter, req.validBefore, nowS);
    if (windowErr) this.reject("bad_signature", windowErr);
    if (!isAddress(req.payer)) this.reject("bad_signature");
    let signer: string;
    try {
      signer = await recoverCheckoutSigner(
        {
          from: req.payer as Hex,
          router: this.cfg.router,
          value: BigInt(row.amount),
          nonce: row.nonce as Hex,
          validAfter: BigInt(req.validAfter),
          validBefore: BigInt(req.validBefore),
          chainId: this.cfg.chainId,
          token: this.cfg.usdt,
        },
        req.signature as Hex,
      );
    } catch {
      this.reject("bad_signature");
    }
    if (signer.toLowerCase() !== req.payer.toLowerCase()) this.reject("bad_signature");

    if (!this.payerLimiter.allow(req.payer.toLowerCase()) || !this.merchantLimiter.allow(row.merchant_id)) {
      this.reject("rate_limited");
    }

    // 5. merchant registered, fee within cap, payout unchanged since the order was created
    const merchant = await this.chain.getMerchant(row.merchant_id as Hex);
    if (merchant.payout === ZERO) this.reject("simulation_failed", "This merchant is not registered.");
    if (BigInt(row.fee) > merchant.maxRelayFee) this.reject("fee_over_cap");
    if (merchant.payout.toLowerCase() !== row.payout) {
      this.db.setStatus(row.id, "expired");
      this.reject("order_expired", "This order is no longer valid. Please start again.");
    }

    // 6. router / relayer not paused
    if (this.localPaused || (await this.chain.isPaused())) this.reject("relayer_paused");

    // 7. per-payer cap over a rolling 24h
    const volume = this.db.payerVolume(req.payer, nowS - DAY);
    if (volume + BigInt(row.amount) > this.cfg.payerCap) {
      this.reject("rate_limited", "Per-payer limit reached for today.");
    }

    // 8. not already settled on chain
    if (await this.chain.isSettled(row.merchant_id as Hex, row.id as Hex)) {
      this.db.setStatus(row.id, "settled");
      this.reject("already_settled");
    }

    // No awaits between this cap check and the SQLite claim: concurrent requests
    // in this single-writer process cannot both reserve the same remaining volume.
    if (this.db.payerVolume(req.payer, this.now() - DAY) + BigInt(row.amount) > this.cfg.payerCap) {
      this.reject("rate_limited", "Per-payer limit reached for today.");
    }
    // Claim the order so concurrent requests cannot both broadcast.
    if (!this.db.claimForRelay(row.id, req.payer, req.signature, req.validAfter, req.validBefore, this.now())) {
      const again = this.db.getOrder(row.id)!;
      if (again.signature?.toLowerCase() === req.signature.toLowerCase() && again.tx_hash) {
        return { orderId: again.id as Hex, status: again.status, txHash: again.tx_hash as Hex };
      }
      this.reject("already_settled");
    }

    const args: PayArgs = {
      merchantId: row.merchant_id as Hex,
      orderId: row.id as Hex,
      payer: req.payer as Hex,
      value: BigInt(row.amount),
      fee: BigInt(row.fee),
      validAfter: BigInt(req.validAfter),
      validBefore: BigInt(req.validBefore),
      signature: req.signature as Hex,
    };

    try {
      // 9-11 run under a lock so the budget check and the spend record cannot interleave.
      const hash = await this.sendLock.run(async () => {
        if (this.localPaused || await this.chain.isPaused()) this.reject("relayer_paused");
        // The claimed amount is already included. Recheck under the send lock.
        if (this.db.payerVolume(req.payer, this.now() - DAY) > this.cfg.payerCap) {
          this.reject("rate_limited", "Per-payer limit reached for today.");
        }
        // 9. eth_call simulation
        let gas: bigint;
        try {
          gas = await this.chain.simulatePay(args);
        } catch (e) {
          this.log("simulation failed", { order: row.id, err: String((e as Error).message).slice(0, 300) });
          this.reject("simulation_failed");
        }
        // 10. gas price ceiling
        const gasPrice = await this.chain.getGasPrice();
        if (this.cfg.maxGasPrice !== null && gasPrice > this.cfg.maxGasPrice) {
          this.reject("relayer_paused", "The network is busy right now. Please try again shortly.");
        }
        // 11. hourly loss budget
        const gasLimit = (gas * 12n) / 10n;
        if (gasLimit > this.cfg.maxGasLimit) this.reject("relayer_paused", "Transaction gas limit exceeds the configured cap.");
        const estimate = gasLimit * gasPrice;
        if (this.db.reservedSpend(this.now() - HOUR) + estimate > this.cfg.lossBudgetWei) {
          this.reject("relayer_paused", "Payments are paused briefly. Please try again later.");
        }
        if (this.localPaused) this.reject("relayer_paused");
        const prepared = await this.chain.preparePay(args, gasLimit, gasPrice);
        this.db.saveAttempt({ hash: prepared.hash, order_id: row.id, raw: prepared.raw,
          nonce: prepared.nonce, gas: gasLimit.toString(), gas_price: gasPrice.toString(), sent_at: this.now(), replacement: 0 });
        // A transport error may occur after the node accepted the transaction.
        // Keep the signed transaction pending and let the monitor recover it.
        try { if (!this.localPaused) await this.chain.broadcast(prepared.raw); }
        catch (e) { this.log("broadcast uncertain; retained for recovery", { order: row.id }); }
        const h = prepared.hash;
        this.relayed += 1;
        return h;
      });
      void this.track(row.id, hash);
      return { orderId: row.id as Hex, status: "pending", txHash: hash };
    } catch (e) {
      if (!(e instanceof QuietpayError)) {
        this.log("broadcast failed", { order: row.id, err: String((e as Error).message).slice(0, 300) });
        this.db.revertClaim(row.id);
        this.reject("simulation_failed", "This payment could not be sent. You have not been charged.");
      }
      this.db.revertClaim(row.id);
      throw e;
    }
  }

  // ------------------------------------------------------------------ tracking

  /** Waits for the receipt and moves the order to settled or failed. Safe to call twice. */
  async track(orderId: string, hash: Hex, receipt?: TxReceipt): Promise<void> {
    if (this.tracking.has(orderId)) return;
    this.tracking.add(orderId);
    try {
      const r = receipt ?? await this.chain.waitForReceipt(hash);
      const row = this.db.getOrder(orderId);
      if (!row || row.status !== "pending") return;
      const attempts = this.db.attempts(orderId);
      const mined = attempts.find(a => a.hash === hash);
      // A late receipt callback from a previous failed attempt must not overwrite a retry.
      if (mined ? mined.nonce !== attempts.at(-1)?.nonce : row.tx_hash !== hash) return;
      this.db.raw.transaction(() => {
        // Only one transaction at this nonce can be mined. Replace its reservation with actual spend.
        for (const a of attempts.filter(a => a.nonce === mined?.nonce)) {
          this.db.raw.prepare("DELETE FROM spend WHERE tx_hash=?").run(a.hash);
        }
        this.db.setTxHash(orderId, hash);
        this.db.recordSpend(hash, this.now(), r.gasUsed * r.effectiveGasPrice);
        if (r.status === "success") {
          this.db.setStatus(orderId, "settled", { settledAt: this.now() });
          this.enqueueWebhook(orderId, "payment.settled");
        } else {
          this.db.setStatus(orderId, "failed", { failureCode: "simulation_failed" });
          this.enqueueWebhook(orderId, "payment.failed");
        }
      })();
    } catch (e) {
      this.log("tracking error; monitor will retry", { order: orderId, err: String((e as Error).message).slice(0, 200) });
    } finally {
      this.tracking.delete(orderId);
    }
  }

  async refreshBalance() {
    const balance = await this.chain.getBalance();
    const low = balance < this.cfg.lowBalanceWei;
    if (low && !this.balanceLow) this.log("low relayer WBT balance", { balanceWbt: formatUnits(balance, 18) });
    this.balanceWei = balance;
    this.balanceLow = low;
  }

  startMonitor() {
    if (this.monitor) return;
    this.recoverPending(true);
    this.monitor = setInterval(() => this.recoverPending(), this.cfg.pendingRetrySeconds * 1000);
    this.monitor.unref();
  }

  stopMonitor() {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
  }

  recoverPending(releaseOrphanClaims = false) {
    void this.refreshBalance().catch(e => this.log("balance read failed", { error: String(e) }));
    for (const row of this.db.pendingOrders()) {
      if (!row.tx_hash) { if (releaseOrphanClaims) this.db.revertClaim(row.id); continue; }
      void this.recoverOrder(row.id).catch(e => this.log("recovery failed", { order: row.id, error: String(e) }));
    }
  }

  async recoverOrder(orderId: string) {
    if (this.tracking.has(orderId) || this.recovering.has(orderId)) return;
    this.recovering.add(orderId);
    try { await this.recoverOrderOnce(orderId); }
    finally { this.recovering.delete(orderId); }
  }

  private async recoverOrderOnce(orderId: string) {
    const row = this.db.getOrder(orderId);
    if (!row || row.status !== "pending" || !row.tx_hash) return;
    // Check every same-nonce candidate: an older transaction may have mined first.
    const attempts = this.db.attempts(orderId);
    const latest = attempts.at(-1);
    if (!latest) { await this.track(orderId, row.tx_hash as Hex); return; }
    for (const a of attempts.filter(a => a.nonce === latest.nonce)) {
      const receipt = await this.chain.getReceipt(a.hash as Hex);
      if (receipt) await this.track(orderId, a.hash as Hex, receipt);
      if (this.db.getOrder(orderId)?.status !== "pending") return;
    }
    await this.sendLock.run(async () => {
      const current = this.db.getOrder(orderId);
      if (current?.status !== "pending" || current.tx_hash !== latest.hash) return;
      if (this.localPaused || await this.chain.isPaused()) return;
      let raw = latest.raw as Hex;
      if (this.now() - latest.sent_at >= this.cfg.pendingRetrySeconds && latest.replacement < this.cfg.maxReplacements
          && row.valid_before !== null && this.now() < row.valid_before) {
        const price = (BigInt(latest.gas_price) * 1125n + 999n) / 1000n;
        const gas = BigInt(latest.gas);
        const delta = gas * (price - BigInt(latest.gas_price));
        if ((this.cfg.maxGasPrice === null || price <= this.cfg.maxGasPrice)
            && this.db.reservedSpend(this.now() - HOUR) + delta <= this.cfg.lossBudgetWei) {
          const tx = await this.chain.preparePay({ merchantId: row.merchant_id as Hex, orderId: row.id as Hex,
            payer: row.payer as Hex, value: BigInt(row.amount), fee: BigInt(row.fee),
            validAfter: BigInt(row.valid_after!), validBefore: BigInt(row.valid_before!), signature: row.signature as Hex }, gas, price, latest.nonce);
          this.db.saveAttempt({ hash: tx.hash, order_id: orderId, raw: tx.raw, nonce: latest.nonce,
            gas: gas.toString(), gas_price: price.toString(), sent_at: this.now(), replacement: latest.replacement + 1 });
          raw = tx.raw;
        }
      }
      try { if (!this.localPaused) await this.chain.broadcast(raw); } catch { /* already known, mined, or temporarily unreachable */ }
    });
  }

  private enqueueWebhook(orderId: string, type: WebhookEvent["type"]) {
    const row = this.db.getOrder(orderId);
    if (!row?.webhook_url) return;
    const event: WebhookEvent = {
      id: `evt_${randomUUID().replace(/-/g, "")}`,
      type,
      createdAt: this.now(),
      data: {
        orderId: row.id as Hex,
        merchantId: row.merchant_id as Hex,
        amount: row.amount,
        fee: row.fee,
        payer: (row.payer as Hex | null) ?? undefined,
        payout: row.payout as Hex,
        txHash: (row.tx_hash as Hex | null) ?? undefined,
        reference: row.reference ?? undefined,
        failureCode: row.failure_code ?? undefined,
      },
    };
    this.db.insertDelivery({
      id: event.id,
      order_id: row.id,
      url: row.webhook_url,
      body: JSON.stringify(event),
      attempts: 0,
      next_attempt_at: this.now(),
      delivered_at: null,
    });
  }
}
