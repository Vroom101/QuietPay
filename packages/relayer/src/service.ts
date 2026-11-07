import { RefundService } from "./refunds.js";
import { randomBytes, randomUUID } from "node:crypto";
import { formatUnits, isAddress, type Hex } from "viem";
import {
  QuietpayError,
  checkAuthWindow,
  computePayNonce,
  recoverCheckoutSigner,
  type CreateOrderRequest,
  type ErrorCode,
  type MetricsResponse,
  type Order,
  type OrderStatus,
  type RelayPayRequest,
  type RelayPayResponse,
} from "@quietpay/shared";
import type { WebhookEvent } from "@quietpay/shared/webhook";
import { CLAIM_GRACE_SECONDS, OWNER_TIMEOUT_SECONDS, rowToOrder, type Db, type DbStatus, type OrderRow } from "./db.js";
import { CANCEL_GAS, type ChainPort, type ExtendedChainPort, type PayArgs, type SignedTx, type TxReceipt } from "./chain.js";
import type { Config } from "./config.js";
import { RateLimiter, clientKey } from "./ratelimit.js";
import { webhookUrlProblem } from "./webhooks.js";

const HOUR = 3600;
const DAY = 86_400;
const ZERO = "0x0000000000000000000000000000000000000000";
/** After the single rebroadcast of a stuck tx, wait this long for it to be mined before failing the order. */
export const REBROADCAST_GRACE_SECONDS = 120;
/** Orders failed because their tx was not seen to execute are re-checked for a late receipt for this long. */
const LATE_RECEIPT_WINDOW_SECONDS = 2 * DAY;
/** An unresolved tx is resolved (cancelled, never rebroadcast) this long after its authorization's validBefore. */
export const VALID_BEFORE_MARGIN_SECONDS = 30;
/** A pending tx the node does not know is re-sent once it is this old (younger ones may still be propagating). */
export const STUCK_RESEND_SECONDS = 60;
/**
 * An Expired revert is blamed on the relayer (not the payer) only if at least this much of the authorization
 * window was left when the tx was signed: a block lands well within it unless the relayer delayed the tx.
 */
export const EXPIRY_EXEMPT_MIN_HEADROOM_SECONDS = 60;
/** After a cancel is sent, wait this long (and past validBefore) before failing the order without it mined. */
export const CANCEL_GRACE_SECONDS = REBROADCAST_GRACE_SECONDS;

/** Failure codes set by reconciliation (stored in failure_code; webhook failureCode). */
export const FAILURE_TX_DROPPED = "tx_dropped"; // no receipt, and the relayer nonce was used by another tx
export const FAILURE_TX_NOT_MINED = "tx_not_mined"; // accepted by the node, never mined; cancelled / timed out
export const FAILURE_TX_NOT_SENT = "tx_not_sent"; // never reached the node; its nonce was filled by a self-transfer
export const FAILURE_TX_EXPIRED = "tx_expired"; // mined after validBefore because the relayer delayed it (not the payer's fault)

/** Send errors after which the signed tx can never use its nonce, or the node's nonce view differs: resync. */
const NONCE_UNUSED_ERRORS = /nonce too low|nonce has already been used|already been used|underpriced|replacement|nonce too high|insufficient funds/i;
/** Send errors that mean the node already has exactly this tx. */
const ALREADY_KNOWN_ERRORS = /already known|known transaction|already imported/i;

export interface ServiceDeps {
  cfg: Config;
  db: Db;
  chain: ChainPort;
  now?: () => number; // unix seconds
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Delay before re-sending a tx whose first send errored and that the node does not know (default 1000 ms). */
  broadcastRetryMs?: number;
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.tail.then(fn);
    this.tail = r.catch(() => undefined);
    return r;
  }
}

interface NewPayerSlot {
  held: boolean;
  ip: string;
  payer: string;
}

/** Relays currently holding one (ip, wallet) new-wallet slot; committed once any of them persisted a signed tx. */
interface SlotHolders {
  holders: number;
  committed: boolean;
}

const UNRESOLVED: readonly DbStatus[] = ["pending", "broadcast_unknown"];
const isUnresolved = (s: DbStatus) => UNRESOLVED.includes(s);
const publicStatus = (s: DbStatus): OrderStatus => (s === "broadcast_unknown" ? "pending" : s);
const errText = (e: unknown, n = 300) => String((e as Error)?.message ?? e).slice(0, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Relayer core.
 *
 * Deployment note: this service is safe to run as several processes that share ONE SQLite database file
 * (claims carry a per-process owner token and every state change is compare-and-set). It is NOT safe to
 * scale horizontally across machines with separate databases, and processes sharing a relayer key also
 * share its nonce space: each process has its own NonceManager, so running more than one process per
 * relayer key needs a shared lock around signPay/sendRawTx (e.g. a DB advisory lock or a single signer
 * service) or one relayer key per process.
 */
export class RelayerService {
  readonly cfg: Config;
  readonly db: Db;
  readonly chain: ExtendedChainPort;
  readonly now: () => number;
  /** Random per-process token stored on every claim this process makes. */
  readonly owner: string = randomBytes(16).toString("hex");
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly ipLimiter: RateLimiter;
  private readonly orderLimiter: RateLimiter;
  readonly sendLock = new Mutex();
  readonly refunds: RefundService;
  private monitor: NodeJS.Timeout | null = null;
  private balanceWei: bigint | null = null;
  private readonly broadcastRetryMs: number;
  private relayed = 0;
  private readonly rejected = new Map<string, number>();
  private readonly tracking = new Set<string>();
  /** Orders this process has claimed and not yet signed or released; never treated as stale. */
  private readonly inflight = new Set<string>();
  private reconciling = false;
  private readonly newPayersByIp = new Map<string, Map<string, number>>();
  private readonly slotHolders = new Map<string, SlotHolders>();

  constructor(d: ServiceDeps) {
    this.cfg = d.cfg;
    this.db = d.db;
    this.chain = d.chain as ExtendedChainPort;
    this.now = d.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = d.log ?? (() => undefined);
    this.broadcastRetryMs = d.broadcastRetryMs ?? 1000;
    this.ipLimiter = new RateLimiter(d.cfg.rateLimitPerMinute, 60_000, () => this.now() * 1000);
    this.orderLimiter = new RateLimiter(Math.max(5, Math.floor(d.cfg.rateLimitPerMinute / 2)), 60_000, () => this.now() * 1000);
    this.refunds = new RefundService(this, d.log);
    this.heartbeat();
  }

  // ------------------------------------------------------------------ admin

  get localPaused(): boolean {
    return this.db.getSetting("paused") === "1";
  }
  setLocalPaused(p: boolean) {
    this.db.setSetting("paused", p ? "1" : "0");
  }

  // ------------------------------------------------------------------ ownership

  /** Marks this process alive. Called on construction, on every relay and on every reconcile tick. */
  heartbeat() {
    this.db.heartbeat(this.owner, this.now());
  }

  private liveOwners(): string[] {
    const live = this.db.liveOwners(this.now() - OWNER_TIMEOUT_SECONDS);
    if (!live.includes(this.owner)) live.push(this.owner);
    return live;
  }

  // ------------------------------------------------------------------ views

  toOrder(row: OrderRow): Order {
    const totals = this.db.refundTotals(row.id);
    return { ...rowToOrder(row, {
      router: this.cfg.router,
      token: this.cfg.usdt,
      chainId: this.cfg.chainId,
      domain: this.cfg.tokenDomain,
      explorerBaseUrl: this.cfg.explorerBaseUrl,
    }), refunded: totals.amount.toString(), refundedAmount: totals.amount.toString(), refundCount: totals.count };
  }

  getOrder(id: string): Order {
    const row = this.db.getOrder(id);
    if (!row) throw new QuietpayError("order_not_found");
    return this.toOrder(this.expireIfNeeded(row));
  }

  listOrders(merchantId: string): Order[] {
    const rows = this.db.listOrders(merchantId);
    const gas = this.db.gasWeiByOrder(rows.map((r) => r.id));
    // gasWei is merchant-only: it is added here, never in toOrder (which also serves the public GET /v1/orders/:id).
    return rows.map((r) => ({ ...this.toOrder(this.expireIfNeeded(r)), gasWei: (gas.get(r.id.toLowerCase()) ?? 0n).toString() }));
  }

  /**
   * Lazy maintenance on read: a stale claim (never signed, no live owner) is released back to its
   * previous state; created and failed orders stop being relayable at expiresAt. Both are compare-and-set.
   */
  private expireIfNeeded(row: OrderRow): OrderRow {
    if (this.isStaleClaim(row) && this.db.revertClaim(row.id, row.claim_owner ?? null)) {
      this.log("released stale claim", { order: row.id });
      row = this.db.getOrder(row.id) ?? row;
    }
    if ((row.status === "created" || row.status === "failed") && this.now() >= row.expires_at) {
      this.db.transition(row.id, ["created", "failed"], "expired");
      return this.db.getOrder(row.id) ?? row;
    }
    return row;
  }

  /**
   * A claim is stale when it never reached signing, is older than the grace, is not being worked on by
   * this process, and its owner is not a live process (no owner = legacy claim; our own token while not
   * in flight = leaked claim). A claim owned by another live process is never stale here.
   */
  private isStaleClaim(row: OrderRow, live?: Set<string>): boolean {
    if (row.status !== "pending" || row.tx_hash !== null || this.inflight.has(row.id)) return false;
    if (row.relayed_at !== null && row.relayed_at >= this.now() - CLAIM_GRACE_SECONDS) return false;
    const owner = row.claim_owner ?? null;
    if (owner === null || owner === this.owner) return true;
    return !(live ?? new Set(this.liveOwners())).has(owner);
  }

  /**
   * Releases every stale claim (crash between claim and signing). Claims still being processed by this
   * process, or owned by another live process, are left alone. Returns how many were released.
   */
  releaseStaleClaims(): number {
    this.heartbeat();
    const live = new Set(this.liveOwners());
    let n = 0;
    for (const row of this.db.staleClaims(this.now() - CLAIM_GRACE_SECONDS)) {
      if (!this.isStaleClaim(row, live)) continue;
      if (this.db.revertClaim(row.id, row.claim_owner ?? null)) {
        n += 1;
        this.log("released stale claim", { order: row.id });
      }
    }
    return n;
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
    const rows = this.db.raw.prepare("SELECT status,COUNT(*) count FROM x402_payments GROUP BY status").all() as { status: string; count: number }[];
    const agents = Object.fromEntries(rows.map(r => [r.status, r.count]));
    return {
      agentPayments: { settling: agents.settling ?? 0, settled: agents.settled ?? 0, failed: agents.failed ?? 0 },
      balanceWbt: this.balanceWei === null ? null : formatUnits(this.balanceWei, 18),
      lowBalance: this.balanceWei !== null && this.balanceWei < this.cfg.lowBalanceWei,
      lowBalanceThresholdWbt: formatUnits(this.cfg.lowBalanceWei, 18),
      orders: {
        created: counts.created ?? 0,
        pending: counts.pending ?? 0,
        settled: counts.settled ?? 0,
        failed: counts.failed ?? 0,
        expired: counts.expired ?? 0,
        partially_refunded: counts.partially_refunded ?? 0,
        refunded: counts.refunded ?? 0,
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
    if (req.webhookUrl !== undefined) {
      const problem = webhookUrlProblem(req.webhookUrl, this.cfg.allowPrivateWebhooks);
      if (problem) throw new QuietpayError("bad_signature", `${problem}.`);
    }
    const m = await this.chain.getMerchant(merchantId);
    if (m.payout === ZERO) throw new QuietpayError("simulation_failed", "This merchant is not registered.");
    const amount = BigInt(req.amount);
    const fee = this.cfg.relayFee < m.maxRelayFee ? this.cfg.relayFee : m.maxRelayFee;
    // The router requires value > fee; an order it can never settle is refused up front.
    if (amount <= fee) {
      throw new QuietpayError("invalid_amount", `Amount must be greater than the relay fee (${fee.toString()} base units).`);
    }
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
      nonce: computePayNonce({ merchantId, orderId: id, payout: m.payout, value: amount, fee }),
      payer: null,
      tx_hash: null,
      signature: null,
      valid_after: null,
      valid_before: null,
      failure_code: null,
      created_at: created,
      expires_at: created + (req.expiresInSeconds ?? 900),
      settled_at: null,
      relayed_at: null,
    };
    this.db.insertOrder(row);
    return this.toOrder(row);
  }

  // ------------------------------------------------------------------ relay

  recordRejection(code: string) { this.rejected.set(code, (this.rejected.get(code) ?? 0) + 1); }
  recordRelay() { this.relayed += 1; }
  async refreshBalance() { this.balanceWei = await this.chain.getBalance(); }
  startMonitor() {
    if (this.monitor) return;
    this.recoverPending();
    this.refunds.recoverPending(true);
    this.monitor = this.startReconciler();
  }
  stopMonitor() { if (this.monitor) clearInterval(this.monitor); this.monitor = null; }
  async recoverOrder(_id: string) { await this.reconcile(); }
  private reject(code: ErrorCode, message?: string): never {
    this.rejected.set(code, (this.rejected.get(code) ?? 0) + 1);
    throw new QuietpayError(code, message);
  }

  /**
   * Guard pipeline. Every check runs before anything is signed, and the
   * cheapest checks run first so a flood of junk costs the relayer nothing.
   */
  async relayPay(req: RelayPayRequest, ctx: { ip: string }): Promise<RelayPayResponse> {
    // The new-wallet slot (4d) is reserved synchronously and kept only if a signed tx was persisted for it.
    const slot: NewPayerSlot = { held: false, ip: "", payer: "" };
    try {
      return await this.relayPayInner(req, ctx, slot);
    } finally {
      this.releaseSlot(slot);
    }
  }

  private slotKey(ip: string, payer: string): string {
    return `${ip}|${payer}`;
  }

  /** Drops this relay's hold. The wallet leaves the IP's set only when no other relay holds it and none committed. */
  private releaseSlot(slot: NewPayerSlot): void {
    if (!slot.held) return;
    slot.held = false;
    const k = this.slotKey(slot.ip, slot.payer);
    const h = this.slotHolders.get(k);
    if (!h) return;
    h.holders -= 1;
    if (h.holders > 0) return;
    this.slotHolders.delete(k);
    if (h.committed) return;
    const m = this.newPayersByIp.get(slot.ip);
    m?.delete(slot.payer);
    if (m && m.size === 0) this.newPayersByIp.delete(slot.ip);
  }

  private commitSlot(slot: NewPayerSlot): void {
    if (!slot.held) return;
    const h = this.slotHolders.get(this.slotKey(slot.ip, slot.payer));
    if (h) h.committed = true;
  }

  private async relayPayInner(req: RelayPayRequest, ctx: { ip: string }, slot: NewPayerSlot): Promise<RelayPayResponse> {
    const clientIp = clientKey(ctx.ip);
    // 1. rate limit per client. The per-order limit is charged only after the signature verifies (4b),
    //    so a third party spamming junk with a victim's orderId cannot lock the victim out.
    if (!this.ipLimiter.allow(`ip:${clientIp}`)) this.reject("rate_limited");

    // 2. order exists and is not expired
    const found = this.db.getOrder(req.orderId);
    if (!found) this.reject("order_not_found");
    const row = this.expireIfNeeded(found);

    // Idempotency: the same signature for the same order returns the same hash.
    if (row.signature && row.signature.toLowerCase() === req.signature.toLowerCase() && row.tx_hash) {
      return { orderId: row.id as Hex, status: publicStatus(row.status), txHash: row.tx_hash as Hex };
    }
    if (["settled", "partially_refunded", "refunded"].includes(row.status) || isUnresolved(row.status)) this.reject("already_settled");
    if (row.status === "expired") this.reject("order_expired");

    // 3. amount matches
    if (req.amount !== undefined && req.amount !== row.amount) {
      this.reject("amount_mismatch");
    }

    // 4. signature parses, window is valid and long enough, and it matches the order's typed data
    const nowS = this.now();
    if (nowS >= req.validBefore) this.reject("order_expired", "Your approval expired. Please try again.");
    const windowErr = checkAuthWindow(req.validAfter, req.validBefore, nowS);
    if (windowErr) this.reject("bad_signature", windowErr);
    // A window that ends before the tx can be mined reverts at the relayer's cost: require headroom.
    const remaining = req.validBefore - nowS;
    if (remaining < this.cfg.minValidSeconds) this.reject("bad_signature", "Your approval expires too soon. Please approve again.");
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
          domainName: this.cfg.tokenDomain.name,
          domainVersion: this.cfg.tokenDomain.version,
        },
        req.signature as Hex,
      );
    } catch {
      this.reject("bad_signature");
    }
    if (signer.toLowerCase() !== req.payer.toLowerCase()) this.reject("bad_signature");

    // 4b. per-order limit, keyed by order and verified payer: anyone can sign the order's typed data
    //     with their own key, so keying by payer stops one signer from exhausting another's budget.
    if (!this.orderLimiter.allow(`order:${row.id}:${req.payer.toLowerCase()}`)) this.reject("rate_limited");

    // 4c. payer-caused on-chain reverts (rolling 24h): a payer who made a tx revert must leave a longer
    //     window, is refused after maxRevertsPerDay, and an order that reverted that often is refused
    //     whoever signs it (so rotating keys does not reset the count for one order).
    const reverts = this.db.revertStats(req.payer, nowS - DAY);
    if (reverts.count >= this.cfg.maxRevertsPerDay) {
      this.reject("rate_limited", "Too many failed payments from this wallet today. Please try again tomorrow.");
    }
    if (reverts.count > 0 && remaining < this.cfg.revertedPayerMinValidSeconds) {
      this.reject("bad_signature", "Your approval expires too soon. Please approve again.");
    }
    if (this.db.orderRevertCount(row.id, nowS - DAY) >= this.cfg.maxRevertsPerDay) {
      this.reject("rate_limited", "This order failed too many times. Please start a new payment.");
    }

    // 4d. first-time payers (no settled order yet) are the cheap way to burn gas: fresh keys cost nothing.
    //     Their reverts draw on a separate pool (capped), and one client IP may only bring a few new keys an hour.
    const firstTime = !this.db.hasSettlement(req.payer);
    if (firstTime) {
      const ftCap = (this.cfg.lossBudgetWei * BigInt(this.cfg.firstTimePayerLossCapPercent)) / 100n;
      const ftLost = this.db.firstTimeRevertWei(nowS - HOUR);
      if (ftLost > 0n && ftLost >= ftCap) {
        this.reject("rate_limited", "Too many failed payments from new wallets right now. Please try again later.");
      }
      // Check and reserve with no await in between, so concurrent relays cannot all see an empty set.
      const m = this.newPayersFor(clientIp, nowS);
      const key = req.payer.toLowerCase();
      if (!m.has(key) && m.size >= this.cfg.maxNewPayersPerIpPerHour) {
        this.reject("rate_limited", "Too many new wallets from this connection. Please try again later.");
      }
      const sk = this.slotKey(clientIp, key);
      const had = m.has(key);
      if (!had) {
        m.set(key, nowS);
        this.newPayersByIp.set(clientIp, m);
      }
      let h = this.slotHolders.get(sk);
      if (!h) {
        // A wallet already in the set with no holder record was committed by an earlier, finished relay.
        h = { holders: 0, committed: had };
        this.slotHolders.set(sk, h);
      }
      h.holders += 1;
      slot.held = true;
      slot.ip = clientIp;
      slot.payer = key;
    }

    // 5. merchant registered, fee within cap, payout unchanged since the order was created
    const merchant = await this.chain.getMerchant(row.merchant_id as Hex);
    if (merchant.payout === ZERO) this.reject("simulation_failed", "This merchant is not registered.");
    if (BigInt(row.fee) > merchant.maxRelayFee) this.reject("fee_over_cap");
    if (merchant.payout.toLowerCase() !== row.payout) {
      // Only an order nobody is paying right now may expire; a concurrent in-flight payment is left alone.
      this.db.transition(row.id, ["created", "failed"], "expired");
      this.reject("order_expired", "This order is no longer valid. Please start again.");
    }

    // 6. router / relayer not paused
    if (this.localPaused || (await this.chain.isPaused())) this.reject("relayer_paused");

    // 7. not already settled on chain
    if (await this.chain.isSettled(row.merchant_id as Hex, row.id as Hex)) {
      this.observeSettled(row.id);
      this.reject("already_settled");
    }

    // 8. Claim the order so concurrent requests cannot both broadcast. The per-payer cap over a rolling
    //    24h (measured from relay time) is checked inside the same transaction as the claim, so two
    //    concurrent relays for one payer cannot both pass it. Claims held by live processes always count.
    this.heartbeat();
    const claim = this.db.claimForRelay(row.id, req.payer, req.signature, req.validAfter, req.validBefore, {
      now: this.now(),
      payerCap: this.cfg.payerCap,
      windowSeconds: DAY,
      owner: this.owner,
      liveOwners: this.liveOwners(),
    });
    if (claim === "over_cap") this.reject("rate_limited", "Per-payer limit reached for today.");
    if (claim !== "ok") {
      const again = this.db.getOrder(row.id)!;
      if (again.signature?.toLowerCase() === req.signature.toLowerCase() && again.tx_hash) {
        return { orderId: again.id as Hex, status: publicStatus(again.status), txHash: again.tx_hash as Hex };
      }
      this.reject("already_settled");
    }
    this.inflight.add(row.id);

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
    // Set once a signed tx is persisted on the order: from then on the claim is never released as unpaid.
    const persisted: { hash: Hex | null } = { hash: null };

    try {
      // 9-12 run under a lock so the budget check, the nonce and the spend record cannot interleave.
      const out = await this.sendLock.run(async () => {
        // 9. eth_call simulation (against the pending block)
        let gas: bigint;
        try {
          gas = await this.chain.simulatePay(args);
        } catch (e) {
          this.log("simulation failed", { order: row.id, err: errText(e) });
          this.reject("simulation_failed");
        }
        // 10. gas price ceiling
        const gasPrice = await this.chain.getGasPrice();
        if (this.cfg.maxGasPrice !== null && gasPrice > this.cfg.maxGasPrice) {
          this.reject("relayer_paused", "The network is busy right now. Please try again shortly.");
        }
        // 11. hourly loss budget, and this payer's share of it: gas burnt by the payer's reverted txs in
        //     the last hour may not exceed payerLossSharePercent of the budget, so one payer cannot pause
        //     everyone. Successful payments (which pay the relay fee) do not count toward the share.
        const gasLimit = (gas * 12n) / 10n;
        const estimate = gasLimit * gasPrice;
        // Reverts by first-time payers count toward the shared budget only up to their share: losses above
        // it (fresh keys reverting on purpose) are bounded by the first-time cap in 4d and never pause others.
        const ftShare = (this.cfg.lossBudgetWei * BigInt(this.cfg.firstTimePayerLossSharePercent)) / 100n;
        const ftLost = this.db.firstTimeRevertWei(nowS - HOUR);
        const ftExcess = ftLost > ftShare ? ftLost - ftShare : 0n;
        if (this.db.reservedSpend(nowS - HOUR) - ftExcess + estimate > this.cfg.lossBudgetWei) {
          this.reject("relayer_paused", "Payments are paused briefly. Please try again later.");
        }
        const share = (this.cfg.lossBudgetWei * BigInt(this.cfg.payerLossSharePercent)) / 100n;
        // This payer's txs that are signed but not yet resolved may still revert: they count as reverts and as
        // potential loss, so a burst sent before the first receipt cannot get past the limits.
        const inflight = this.db.unresolvedPayerTxs(req.payer);
        if (this.db.revertStats(req.payer, nowS - DAY).count + inflight.count >= this.cfg.maxRevertsPerDay && inflight.count > 0) {
          this.reject("rate_limited", "Too many payments from this wallet are still being confirmed. Please try again shortly.");
        }
        const lost = this.db.revertStats(req.payer, nowS - HOUR).wei + inflight.wei;
        if (lost > 0n && lost + estimate > share) {
          this.reject("rate_limited", "Too many failed payments from this wallet. Please try again later.");
        }
        // 12. sign locally, persist the signed bytes on the order, then send.
        const cur = this.db.getOrder(row.id);
        if (!cur || cur.status !== "pending" || cur.tx_hash !== null || (cur.claim_owner ?? null) !== this.owner) {
          throw new Error("claim lost before signing");
        }
        const signed = await this.chain.signPay(args, gasLimit, gasPrice);
        let ok = false;
        try {
          ok = this.db.persistSignedTx(row.id, this.owner, { ...signed, gasPrice }, this.now());
        } catch (e) {
          this.log("could not persist signed tx", { order: row.id, err: errText(e) });
        }
        if (!ok) {
          // Never sent and never will be: give the nonce back so the next tx does not leave a gap.
          this.chain.resyncNonce();
          throw new Error("claim lost before broadcast");
        }
        persisted.hash = signed.hash;
        this.commitSlot(slot);
        this.db.recordSpend(signed.hash, nowS, estimate);
        this.relayed += 1;
        const sent = await this.broadcast(row.id, signed);
        return { hash: signed.hash, sent };
      });
      if (out.sent) void this.track(row.id, out.hash);
      return { orderId: row.id as Hex, status: "pending", txHash: out.hash };
    } catch (e) {
      if (persisted.hash) {
        // Defensive: broadcast() does not throw, but a persisted tx may be on the network. Never release it.
        this.db.markBroadcastUnknown(row.id, persisted.hash);
        this.log("unexpected error after persisting signed tx", { order: row.id, err: errText(e) });
        return { orderId: row.id as Hex, status: "pending", txHash: persisted.hash };
      }
      // Nothing was signed: restore the exact pre-claim state (only while this process still owns the
      // claim) so a rejected attempt neither locks the order nor counts toward the payer's cap.
      this.db.revertClaim(row.id, this.owner);
      if (!(e instanceof QuietpayError)) {
        this.log("relay failed before signing", { order: row.id, err: errText(e) });
        this.reject("simulation_failed", "This payment could not be sent. You have not been charged.");
      }
      throw e;
    } finally {
      this.inflight.delete(row.id);
    }
  }

  /** Distinct first-time payers relayed per client IP in the last hour (in memory, per process). */
  private newPayersFor(ip: string, nowS: number): Map<string, number> {
    // A fresh map is only attached to newPayersByIp once a wallet is added, so idle /64s leave no entry.
    const m = this.newPayersByIp.get(ip) ?? new Map<string, number>();
    for (const [p, ts] of m) if (ts < nowS - HOUR) m.delete(p);
    if (m.size === 0) this.newPayersByIp.delete(ip);
    return m;
  }

  private async nodeHas(hash: Hex): Promise<boolean> {
    try {
      return await this.chain.hasTransaction(hash);
    } catch {
      return false;
    }
  }

  /**
   * Sends a persisted signed tx. A send that errors is ambiguous (the node may have accepted it before the
   * client timed out), so the hash is looked up; if the node does not have it, the same bytes are re-sent
   * once after a short delay and looked up again. Still unknown: the order becomes broadcast_unknown and
   * keeps its nonce reserved; reconciliation decides. Returns true if the node is known to have the tx.
   */
  private async broadcast(orderId: string, s: SignedTx): Promise<boolean> {
    try {
      await this.chain.sendRawTx(s.raw);
      return true;
    } catch (e) {
      const msg = errText(e);
      this.log("broadcast error; checking whether the node has the tx", { order: orderId, hash: s.hash, err: msg });
      // The nonce was taken by another tx: this one can never be mined, so the cached nonce is wrong too.
      if (/nonce too low|nonce has already been used|replacement transaction underpriced/i.test(msg)) this.chain.resyncNonce();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await this.nodeHas(s.hash)) return true;
      if (attempt === 0) {
        if (this.broadcastRetryMs > 0) await sleep(this.broadcastRetryMs);
        try {
          await this.chain.sendRawTx(s.raw);
          return true;
        } catch (e) {
          this.log("rebroadcast error", { order: orderId, hash: s.hash, err: errText(e) });
        }
      }
    }
    this.db.markBroadcastUnknown(orderId, s.hash);
    this.log("broadcast outcome unknown; left for reconciliation", { order: orderId, hash: s.hash, nonce: s.nonce });
    return false;
  }

  // ------------------------------------------------------------------ settlement (single path)

  /**
   * Applies a receipt for exactly this tx: records the real gas spent, then settles or fails the order
   * if (and only if) it is still unresolved on this hash. Every observer (live tracker, reconciliation,
   * restart recovery) goes through here, so settled_at is always set and exactly one webhook is queued.
   * A revert is recorded against the payer and the order. Returns true if this call made the transition.
   */
  private async applyReceipt(orderId: string, hash: Hex, r: TxReceipt): Promise<boolean> {
    const row = this.db.getOrder(orderId);
    if (!row) return false;
    const wei = r.gasUsed * r.effectiveGasPrice;
    this.db.recordSpend(hash, this.now(), wei);
    this.db.discardLosingSpend(orderId, hash); // a different tx at this nonce can no longer mine
    if (r.status === "success") {
      // Reorg protection: below SETTLE_CONFIRMATIONS the receipt is not trusted yet. The order stays as it is
      // and reconciliation looks again; a receipt that disappears meanwhile never settled anything.
      if (this.cfg.settleConfirmations > 1) {
        const head = await this.chain.getBlockNumber();
        if (head - r.blockNumber + 1n < BigInt(this.cfg.settleConfirmations)) return false;
      }
      // A success receipt for any pay tx of this order proves it was paid, whatever local state it is in.
      if (!this.db.finishTx(orderId, hash, "settled", { settledAt: this.now() }) && !this.db.settleAttempt(orderId, hash, this.now())) {
        return false;
      }
      this.enqueueWebhook(orderId, "payment.settled");
      return true;
    }
    // Reverted. If an earlier attempt of this order paid it (the revert is then AlreadySettled), settle on that
    // attempt: the payer did nothing wrong and the merchant was paid.
    if (row.status !== "settled" && (await this.settleFromOtherAttempt(orderId, hash, { checkRouter: true }))) return true;
    // Mined at or after validBefore (the router's Expired check) although the payer left ample headroom when
    // the tx was signed: the relayer held it back (e.g. queued behind a nonce gap), so it is not counted as the
    // payer's revert. A payer who signed a window too short to survive inclusion is still charged the revert.
    const signedAt = row.tx_signed_at ?? row.relayed_at ?? null;
    const headroom = row.valid_before !== null && signedAt !== null ? row.valid_before - signedAt : 0;
    const expired =
      r.blockTimestamp !== undefined &&
      row.valid_before !== null &&
      r.blockTimestamp >= BigInt(row.valid_before) &&
      headroom >= Math.max(this.cfg.minValidSeconds, EXPIRY_EXEMPT_MIN_HEADROOM_SECONDS);
    if (!this.db.finishTx(orderId, hash, "failed", { failureCode: expired ? FAILURE_TX_EXPIRED : "simulation_failed" })) return false;
    if (row.payer && !expired) this.db.recordRevert({ txHash: hash, orderId, payer: row.payer, ts: this.now(), wei });
    this.enqueueWebhook(orderId, "payment.failed");
    return true;
  }

  /**
   * Looks for a success receipt among this order's other pay attempts (a retry may supersede a tx that still
   * lands). Found: settles the order on that attempt (once, with one payment.settled) and returns true. With
   * `checkRouter`, an order the router already shows as settled is also settled. Lookup errors are skipped.
   */
  private async settleFromOtherAttempt(orderId: string, exceptHash: string, opts: { checkRouter: boolean }): Promise<boolean> {
    for (const a of this.db.payAttempts(orderId)) {
      if (a.tx_hash.toLowerCase() === exceptHash.toLowerCase()) continue;
      let r: TxReceipt | null = null;
      try {
        r = await this.chain.getReceipt(a.tx_hash as Hex);
      } catch {
        continue;
      }
      if (r?.status !== "success") continue;
      this.db.recordSpend(a.tx_hash, this.now(), r.gasUsed * r.effectiveGasPrice);
      if (this.db.settleAttempt(orderId, a.tx_hash, this.now())) {
        this.enqueueWebhook(orderId, "payment.settled");
        this.log("order settled by an earlier attempt", { order: orderId, hash: a.tx_hash });
      }
      return true;
    }
    if (!opts.checkRouter) return false;
    const row = this.db.getOrder(orderId);
    if (!row) return false;
    try {
      if (!(await this.chain.isSettled(row.merchant_id as Hex, row.id as Hex))) return false;
    } catch {
      return false;
    }
    this.observeSettled(orderId);
    return true;
  }

  /** Fails an unresolved tx that can no longer (or is presumed not to) be mined. Queues payment.failed once. */
  private failUnmined(orderId: string, hash: Hex, code: string, opts: { zeroSpend: boolean }): boolean {
    if (!this.db.finishTx(orderId, hash, "failed", { failureCode: code })) return false;
    if (opts.zeroSpend) this.db.recordSpend(hash, this.now(), 0n); // a dropped tx burnt no gas
    this.chain.resyncNonce(); // its nonce is either used by another tx or free again: refetch
    this.enqueueWebhook(orderId, "payment.failed");
    this.log("tx failed by reconciliation", { order: orderId, hash, code });
    return true;
  }

  /**
   * The order is settled on chain. Whatever local state it is in, move it to settled through a
   * compare-and-set transition with settled_at and exactly one payment.settled webhook.
   */
  private observeSettled(orderId: string) {
    const row = this.db.getOrder(orderId);
    if (!row) return;
    if (isUnresolved(row.status) && row.tx_hash) {
      if (this.db.finishTx(orderId, row.tx_hash, "settled", { settledAt: this.now() })) this.enqueueWebhook(orderId, "payment.settled");
      return;
    }
    if (this.db.transition(orderId, ["created", "failed"], "settled", { settledAt: this.now() })) {
      this.enqueueWebhook(orderId, "payment.settled");
    }
  }

  // ------------------------------------------------------------------ tracking

  /** Waits for the receipt and moves the order to settled or failed. Safe to call twice. */
  async track(orderId: string, hash: Hex): Promise<void> {
    if (this.tracking.has(orderId)) return;
    this.tracking.add(orderId);
    try {
      const r = await this.chain.waitForReceipt(hash);
      await this.applyReceipt(orderId, hash, r);
    } catch (e) {
      this.log("tracking stopped; reconciliation will pick it up", { order: orderId, err: errText(e, 200) });
    } finally {
      this.tracking.delete(orderId);
    }
  }

  /**
   * Startup recovery. Claims that never reached signing are released to their previous state (a failed
   * order stays failed: its old reverted hash is not re-tracked). Orders pending on a sent tx are
   * re-attached; applyReceipt only transitions an order still unresolved on that same hash, so this cannot
   * emit a second event. broadcast_unknown orders are left to reconcile().
   */
  recoverPending(_releaseOrphans = false) {
    this.refunds.recoverPending(_releaseOrphans);
    this.releaseStaleClaims();
    for (const row of this.db.pendingOrders()) void this.track(row.id, row.tx_hash as Hex);
  }

  // ------------------------------------------------------------------ reconciliation

  /** Runs reconcile() every `intervalMs` (default RECONCILE_INTERVAL_SECONDS) on an unref'd timer. */
  startReconciler(intervalMs = this.cfg.reconcileIntervalSeconds * 1000): NodeJS.Timeout {
    const t = setInterval(() => {
      this.reconcile().catch((e) => this.log("reconcile error", { err: errText(e) }));
    }, intervalMs);
    t.unref();
    return t;
  }

  /**
   * One reconciliation pass over every order with a signed, unresolved tx (pending / broadcast_unknown):
   *  - receipt found: settle or fail it (applyReceipt; never double-settles);
   *  - no receipt and the relayer's mined nonce is past the tx nonce: it was replaced or dropped and can
   *    never be mined -> failed (tx_dropped), payment.failed once;
   *  - no receipt, nonce not used, older than txMaxAgeSeconds: rebroadcast the persisted raw tx once; if
   *    still not mined REBROADCAST_GRACE_SECONDS later -> failed (tx_not_mined), payment.failed once.
   * Orders failed as tx_not_mined keep being checked for a late receipt and settle (once) if it lands.
   * Also heartbeats and sweeps stale claims. Overlapping calls are no-ops.
   */
  async reconcile(): Promise<{ settled: number; failed: number; rebroadcast: number }> {
    this.refunds.recoverPending();
    const out = { settled: 0, failed: 0, rebroadcast: 0 };
    if (this.reconciling) return out;
    this.reconciling = true;
    try {
      this.releaseStaleClaims(); // also heartbeats
      let confirmed: number | null | undefined;
      const confirmedNonce = async () => {
        if (confirmed === undefined) {
          try {
            confirmed = await this.chain.getConfirmedNonce();
          } catch (e) {
            this.log("could not read relayer nonce", { err: errText(e) });
            confirmed = null;
          }
        }
        return confirmed;
      };
      for (const row of this.db.unresolvedTxs()) {
        try {
          await this.reconcileOne(row, confirmedNonce, out);
        } catch (e) {
          this.log("reconcile: order skipped", { order: row.id, err: errText(e) });
        }
      }
      // Orders failed because their tx was not seen to execute (not mined, dropped, not sent): any of their pay
      // attempts may still turn up mined (a lagging RPC backend, a reorg, a late mempool), so keep checking.
      for (const row of this.db.lateCheckFailures(this.now() - LATE_RECEIPT_WINDOW_SECONDS)) {
        try {
          if (await this.settleFromOtherAttempt(row.id, "", { checkRouter: false })) {
            out.settled += 1;
            this.log("late receipt: order settled after all", { order: row.id });
          }
        } catch (e) {
          this.log("reconcile: late check skipped", { order: row.id, err: errText(e) });
        }
      }
    } finally {
      this.reconciling = false;
    }
    return out;
  }

  private async reconcileOne(
    row: OrderRow,
    confirmedNonce: () => Promise<number | null>,
    out: { settled: number; failed: number; rebroadcast: number },
  ) {
    const hash = row.tx_hash as Hex;
    const count = (r: TxReceipt) => (r.status === "success" ? (out.settled += 1) : (out.failed += 1));
    const r = await this.chain.getReceipt(hash);
    if (r) {
      if (await this.applyReceipt(row.id, hash, r)) count(r);
      return;
    }
    // A superseded earlier attempt of this order (failed, then retried) may have landed after all.
    if (this.db.payAttempts(row.id).length > 1 && (await this.settleFromOtherAttempt(row.id, hash, { checkRouter: false }))) {
      out.settled += 1;
      return;
    }
    if (row.tx_nonce !== null && row.tx_nonce !== undefined) {
      const c = await confirmedNonce();
      if (c !== null && c > row.tx_nonce) {
        // Mined between the two reads? Check once more before declaring it replaced or dropped.
        const again = await this.chain.getReceipt(hash);
        if (again) {
          if (await this.applyReceipt(row.id, hash, again)) count(again);
          return;
        }
        // Our own cancel / gap-filling transfer consumed the nonce: the code chosen when it was signed applies.
        let code = FAILURE_TX_DROPPED;
        if (row.cancel_hash) {
          code = row.cancel_code ?? FAILURE_TX_DROPPED;
          try {
            const cr = await this.chain.getReceipt(row.cancel_hash as Hex);
            if (cr) this.db.recordSpend(row.cancel_hash, this.now(), cr.gasUsed * cr.effectiveGasPrice);
          } catch {
            /* the estimate recorded at signing stays */
          }
        }
        if (this.failUnmined(row.id, hash, code, { zeroSpend: true })) out.failed += 1;
        return;
      }
    }
    if (row.status === "broadcast_unknown" && (await this.nodeHas(hash))) {
      // Another backend had it after all: back to normal tracking.
      if (this.db.markBroadcastKnown(row.id, hash)) void this.track(row.id, hash);
      return;
    }
    const now = this.now();
    const signedAt = row.tx_signed_at ?? row.relayed_at ?? now;
    if (await this.recoverNonceGap(row, hash, now - signedAt, confirmedNonce, out)) return;
    if (now - signedAt < this.cfg.txMaxAgeSeconds) return;
    if (row.rebroadcast_at === null || row.rebroadcast_at === undefined) {
      if (!this.db.markRebroadcast(row.id, hash, now)) return;
      if (!row.raw_tx) return; // legacy row without bytes: just start the grace period
      out.rebroadcast += 1;
      try {
        await this.chain.sendRawTx(row.raw_tx as Hex);
        this.log("rebroadcast stuck tx", { order: row.id, hash });
        if (row.status === "broadcast_unknown") this.db.markBroadcastKnown(row.id, hash);
        void this.track(row.id, hash);
      } catch (e) {
        this.log("rebroadcast failed", { order: row.id, hash, err: errText(e) });
      }
      return;
    }
    if (now - row.rebroadcast_at < REBROADCAST_GRACE_SECONDS) return;
    if (this.failUnmined(row.id, hash, FAILURE_TX_NOT_MINED, { zeroSpend: false })) out.failed += 1;
  }

  /**
   * Nonce-gap recovery for an unresolved tx with no receipt whose nonce is not used yet. A tx the node does not
   * have (it never arrived, or was evicted) leaves a hole at its nonce, and every later tx from the relayer
   * queues behind it, so it is not left for txMaxAgeSeconds:
   *  - while its authorization is still valid, its persisted bytes (same hash) are re-sent once it is
   *    STUCK_RESEND_SECONDS old, on every pass the node still lacks it;
   *  - once the authorization has expired, if it is the relayer's next nonce and other txs are queued behind it,
   *    the nonce is filled with a zero-value self-transfer (signCancel), never by re-sending a pay that would
   *    revert. The order then fails as tx_not_sent when that nonce is consumed.
   * Returns true if it acted (the caller stops for this pass).
   */
  private async recoverNonceGap(
    row: OrderRow,
    hash: Hex,
    age: number,
    confirmedNonce: () => Promise<number | null>,
    out: { settled: number; failed: number; rebroadcast: number },
  ): Promise<boolean> {
    if (age < STUCK_RESEND_SECONDS || row.valid_before === null) return false;
    const now = this.now();
    if (row.cancel_hash) {
      // A cancel is out for this nonce: keep it in the node's pool until the nonce is consumed.
      const cancel = this.db.getAttempt(row.cancel_hash);
      if (cancel?.raw && !(await this.nodeHas(row.cancel_hash as Hex))) {
        try {
          await this.chain.sendRawTx(cancel.raw as Hex);
        } catch (e) {
          this.log("cancel resend failed", { order: row.id, hash: row.cancel_hash, err: errText(e) });
        }
      }
      // A cancel that never gets mined falls back to the max-age path in the end.
      return now - (row.cancel_at ?? now) < this.cfg.txMaxAgeSeconds;
    }
    const unknown = row.status === "broadcast_unknown" || !(await this.nodeHas(hash));
    if (!unknown) return false;

    if (now < row.valid_before && row.raw_tx) {
      out.rebroadcast += 1;
      try {
        await this.chain.sendRawTx(row.raw_tx as Hex);
        this.log("re-sent a tx the node did not have", { order: row.id, hash, nonce: row.tx_nonce });
      } catch (e) {
        const msg = errText(e);
        if (!ALREADY_KNOWN_ERRORS.test(msg)) {
          this.log("re-send of a stuck tx failed", { order: row.id, hash, err: msg });
          if (NONCE_UNUSED_ERRORS.test(msg)) this.chain.resyncNonce();
          return true;
        }
      }
      if (row.status === "broadcast_unknown") this.db.markBroadcastKnown(row.id, hash);
      void this.track(row.id, hash);
      return true;
    }

    // Expired: fill the hole only if it is the next nonce and something is actually queued behind it.
    const nonce = row.tx_nonce;
    if (nonce === null || nonce === undefined || !this.chain.signCancel) return false;
    if (now < row.valid_before + VALID_BEFORE_MARGIN_SECONDS) return false; // may still be mining: not yet
    const c = await confirmedNonce();
    if (c === null || c !== nonce) return false;
    if (!this.db.hasUnresolvedAbove(nonce) || this.db.nonceTakenByOther(nonce, hash)) return false;
    let gasPrice: bigint;
    try {
      gasPrice = await this.chain.getGasPrice();
    } catch (e) {
      this.log("gap fill: could not read gas price", { order: row.id, err: errText(e) });
      return true;
    }
    const prev = this.db.getAttempt(hash)?.gas_price;
    if (prev) {
      // Beat the pay tx at this nonce in case some node still holds it (replacement needs a price bump).
      const bumped = (BigInt(prev) * 115n) / 100n + 1n;
      if (bumped > gasPrice) gasPrice = bumped;
    }
    if (this.cfg.maxGasPrice !== null && gasPrice > this.cfg.maxGasPrice) return true;
    const cancel = await this.chain.signCancel(nonce, gasPrice);
    if (!this.db.recordCancel(row.id, hash, { ...cancel, gasPrice }, FAILURE_TX_NOT_SENT, now)) return true;
    this.db.recordSpend(cancel.hash, now, CANCEL_GAS * gasPrice);
    try {
      await this.chain.sendRawTx(cancel.raw);
      this.log("filled a nonce gap with a self-transfer", { order: row.id, hash, nonce, cancel: cancel.hash });
    } catch (e) {
      this.log("gap fill send failed; retried next pass", { order: row.id, cancel: cancel.hash, err: errText(e) });
    }
    return true;
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
