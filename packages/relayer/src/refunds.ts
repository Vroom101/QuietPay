import { randomUUID } from "node:crypto";
import { keccak256, stringToHex, recoverTypedDataAddress, type Hex } from "viem";
import { QuietpayError, buildRefundAuthorization, checkAuthWindow, type RelayRefundRequest, type Refund, type RefundContext } from "@quietpay/shared";
import type { RelayerService } from "./service.js";
import type { RefundRow } from "./db.js";
import type { RefundArgs, TxReceipt } from "./chain.js";
import { RateLimiter } from "./ratelimit.js";

/** Refunds share the payment sender lock, wallet nonce manager and persisted gas budget. */
export class RefundService {
  private readonly busy = new Set<string>();
  private readonly limiter: RateLimiter;
  constructor(private readonly svc: RelayerService,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined) {
    this.limiter = new RateLimiter(svc.cfg.rateLimitPerMinute, 60_000, () => svc.now() * 1000);
  }
  private owned(merchant: string, orderId: string) {
    const row = this.svc.db.getOrder(orderId);
    if (!row || row.merchant_id !== merchant.toLowerCase()) throw new QuietpayError("order_not_found");
    return row;
  }
  view(row: RefundRow): Refund {
    return { id: row.id, orderId: row.order_id, amount: row.amount, refundIndex: row.refund_index,
      status: row.status, txHash: row.tx_hash ?? undefined, failureCode: row.failure_code ?? undefined, createdAt: row.created_at };
  }
  get(merchant: string, id: string): Refund {
    const row = this.svc.db.getRefund(id);
    if (!row || row.merchant_id !== merchant.toLowerCase()) throw new QuietpayError("order_not_found");
    return this.view(row);
  }
  list(merchant: string, orderId: string): Refund[] {
    this.owned(merchant, orderId);
    const rows = this.svc.db.raw.prepare("SELECT * FROM refunds WHERE order_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100")
      .all(orderId.toLowerCase()) as RefundRow[];
    return rows.map(row => this.view(row));
  }
  async context(merchant: Hex, orderId: Hex): Promise<RefundContext> {
    const order = this.owned(merchant, orderId);
    if (!["settled", "partially_refunded", "refunded"].includes(order.status)) throw new QuietpayError("simulation_failed", "Only settled payments can be refunded.");
    const [registry, receipt] = await Promise.all([this.svc.chain.getMerchant(merchant), this.svc.chain.getOrderReceipt(merchant, orderId)]);
    if (!receipt.settled || receipt.payer.toLowerCase() !== order.payer || receipt.value !== BigInt(order.amount)) {
      throw new QuietpayError("simulation_failed", "The payment receipt is not confirmed or does not match the order.");
    }
    if (receipt.refundCount > BigInt(Number.MAX_SAFE_INTEGER)) throw new QuietpayError("simulation_failed");
    return { orderId, merchantId: merchant, payer: receipt.payer, refundSigner: registry.refundSigner,
      amountPaid: receipt.value.toString(), refunded: receipt.refunded.toString(), refundIndex: Number(receipt.refundCount),
      refundBalance: (await this.svc.chain.getTokenBalance(registry.refundSigner)).toString(),
      chainId: this.svc.cfg.chainId, token: this.svc.cfg.usdt, router: this.svc.cfg.router, domain: this.svc.cfg.tokenDomain };
  }
  async submit(merchant: Hex, req: RelayRefundRequest, ip: string): Promise<Refund> {
    this.owned(merchant, req.orderId);
    if (!this.limiter.allow(`ip:${ip}`) || !this.limiter.allow(`merchant:${merchant.toLowerCase()}`)) throw new QuietpayError("rate_limited");
    // Full request identity makes exact retries stable, including after restart.
    const id = keccak256(stringToHex(JSON.stringify([merchant.toLowerCase(), req.orderId.toLowerCase(), req.amount,
      req.refundIndex, req.validAfter, req.validBefore, req.signature.toLowerCase()])));
    return this.svc.sendLock.run(async () => {
      const previous = this.svc.db.getRefund(id);
      if (previous) return this.view(previous);
      const c = await this.context(merchant, req.orderId as Hex);
      if (req.refundIndex !== c.refundIndex) throw new QuietpayError("already_settled", "Refund index has already been used or is out of sequence.");
      if (BigInt(req.amount) + BigInt(c.refunded) > BigInt(c.amountPaid)) throw new QuietpayError("amount_mismatch", "Refund exceeds the remaining paid amount.");
      if (checkAuthWindow(req.validAfter, req.validBefore, this.svc.now())) throw new QuietpayError("bad_signature", "Invalid refund authorization window.");
      const td = buildRefundAuthorization({ merchantId: merchant, orderId: req.orderId as Hex, payer: c.payer as Hex,
        refundSigner: c.refundSigner as Hex, router: c.router as Hex, token: c.token as Hex, chainId: c.chainId,
        domainName: c.domain.name, domainVersion: c.domain.version,
        amount: BigInt(req.amount), refundIndex: BigInt(req.refundIndex), validAfter: BigInt(req.validAfter), validBefore: BigInt(req.validBefore) });
      let signer: string;
      try { signer = await recoverTypedDataAddress({ ...td, signature: req.signature as Hex }); }
      catch { throw new QuietpayError("bad_signature"); }
      if (signer.toLowerCase() !== c.refundSigner.toLowerCase()) throw new QuietpayError("bad_signature");
      if (BigInt(c.refundBalance) < BigInt(req.amount)) throw new QuietpayError("insufficient_refund_balance");
      if (this.svc.localPaused || await this.svc.chain.isPaused()) throw new QuietpayError("relayer_paused");
      if (this.svc.db.pendingRefunds().some(r => r.order_id === req.orderId.toLowerCase())) throw new QuietpayError("already_settled", "A refund for this order is pending.");
      const args = this.args({ ...req, merchant_id: merchant, order_id: req.orderId, valid_after: req.validAfter, valid_before: req.validBefore });
      let gas: bigint;
      try { gas = (await this.svc.chain.simulateRefund(args) * 12n + 9n) / 10n; }
      catch { throw new QuietpayError("simulation_failed", "The refund simulation failed. No refund was sent."); }
      const price = await this.svc.chain.getGasPrice();
      this.checkBudget(gas, price, gas * price);
      if (this.svc.localPaused) throw new QuietpayError("relayer_paused");
      const tx = await this.svc.chain.prepareRefund(args, gas, price);
      const row: RefundRow = { id, order_id: req.orderId.toLowerCase(), merchant_id: merchant.toLowerCase(), amount: req.amount,
        refund_index: req.refundIndex, status: "pending", signature: req.signature, valid_after: req.validAfter,
        valid_before: req.validBefore, tx_hash: null, failure_code: null, created_at: this.svc.now() };
      this.svc.db.raw.transaction(() => {
        this.svc.db.insertRefund(row);
        this.svc.db.saveAttempt({ hash: tx.hash, raw: tx.raw, order_id: id, nonce: tx.nonce,
          gas: gas.toString(), gas_price: price.toString(), sent_at: this.svc.now(), replacement: 0 }, "refunds");
      })();
      try { if (!this.svc.localPaused) await this.svc.chain.broadcast(tx.raw); }
      catch { this.log("refund broadcast uncertain; retained for recovery", { refund: id }); }
      void this.track(id, tx.hash);
      return this.view(this.svc.db.getRefund(id)!);
    });
  }
  private args(r: { merchant_id: string; order_id: string; amount: string; valid_after: number; valid_before: number; signature: string }): RefundArgs {
    return { merchantId: r.merchant_id as Hex, orderId: r.order_id as Hex, amount: BigInt(r.amount),
      validAfter: BigInt(r.valid_after), validBefore: BigInt(r.valid_before), signature: r.signature as Hex };
  }
  private checkBudget(gas: bigint, price: bigint, additional: bigint) {
    const cfg = this.svc.cfg;
    if (gas > cfg.maxGasLimit || (cfg.maxGasPrice !== null && price > cfg.maxGasPrice)
      || this.svc.db.reservedSpend(this.svc.now() - 3600) + additional > cfg.lossBudgetWei) throw new QuietpayError("relayer_paused", "Refund exceeds configured gas or loss limits.");
  }
  private finish(id: string, hash: Hex, receipt: TxReceipt) {
    const db = this.svc.db, row = db.getRefund(id);
    if (!row || row.status !== "pending") return;
    db.raw.transaction(() => {
      for (const a of db.attempts(id)) db.raw.prepare("DELETE FROM spend WHERE tx_hash=?").run(a.hash);
      db.recordSpend(hash, this.svc.now(), receipt.gasUsed * receipt.effectiveGasPrice);
      db.raw.prepare("UPDATE refunds SET status=?,tx_hash=?,failure_code=? WHERE id=?")
        .run(receipt.status === "success" ? "settled" : "failed", hash, receipt.status === "success" ? null : "simulation_failed", id);
      if (receipt.status !== "success") return;
      const total = db.refundTotals(row.order_id).amount;
      const order = db.getOrder(row.order_id)!;
      db.transition(order.id, ["settled", "partially_refunded"], total === BigInt(order.amount) ? "refunded" : "partially_refunded");
      if (order.webhook_url) {
        const event = { id: `evt_${randomUUID().replace(/-/g, "")}`, type: "payment.refunded", createdAt: this.svc.now(),
          data: { orderId: order.id, merchantId: order.merchant_id, amount: order.amount, fee: order.fee,
            payer: order.payer, payout: order.payout, reference: order.reference ?? undefined, txHash: hash,
            refundId: id, refundAmount: row.amount, totalRefunded: total.toString(), refundIndex: row.refund_index } };
        db.insertDelivery({ id: event.id, order_id: order.id, url: order.webhook_url, body: JSON.stringify(event),
          attempts: 0, next_attempt_at: this.svc.now(), delivered_at: null });
      }
    })();
  }
  async track(id: string, hash: Hex) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try { this.finish(id, hash, await this.svc.chain.waitForReceipt(hash)); }
    catch { this.log("refund receipt pending; monitor will retry", { refund: id }); }
    finally { this.busy.delete(id); }
  }
  recoverPending(releaseOrphans = false) {
    for (const row of this.svc.db.pendingRefunds()) {
      if (!row.tx_hash) {
        if (releaseOrphans) this.svc.db.raw.prepare("DELETE FROM refunds WHERE id=? AND tx_hash IS NULL").run(row.id);
        continue;
      }
      void this.recover(row.id).catch(e => this.log("refund recovery failed", { refund: row.id, error: String(e) }));
    }
  }
  async recover(id: string) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const row = this.svc.db.getRefund(id);
      if (!row || row.status !== "pending") return;
      const attempts = this.svc.db.attempts(id), latest = attempts.at(-1);
      if (!latest) return;
      for (const a of attempts) {
        const receipt = await this.svc.chain.getReceipt(a.hash as Hex);
        if (receipt) { this.finish(id, a.hash as Hex, receipt); return; }
      }
      await this.svc.sendLock.run(async () => {
        if (this.svc.db.getRefund(id)?.status !== "pending" || this.svc.localPaused || await this.svc.chain.isPaused()) return;
        let raw = latest.raw as Hex;
        if (this.svc.now() - latest.sent_at >= this.svc.cfg.pendingRetrySeconds
          && latest.replacement < this.svc.cfg.maxReplacements && this.svc.now() < row.valid_before) {
          const gas = BigInt(latest.gas), price = (BigInt(latest.gas_price) * 1125n + 999n) / 1000n;
          try {
            this.checkBudget(gas, price, gas * (price - BigInt(latest.gas_price)));
            const tx = await this.svc.chain.prepareRefund(this.args(row), gas, price, latest.nonce);
            this.svc.db.saveAttempt({ hash: tx.hash, raw: tx.raw, order_id: id, nonce: latest.nonce,
              gas: gas.toString(), gas_price: price.toString(), sent_at: this.svc.now(), replacement: latest.replacement + 1 }, "refunds");
            raw = tx.raw;
          } catch (e) { if (!(e instanceof QuietpayError)) throw e; }
        }
        try { if (!this.svc.localPaused) await this.svc.chain.broadcast(raw); } catch { /* retained for the next monitor pass */ }
      });
    } finally { this.busy.delete(id); }
  }
}
