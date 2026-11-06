import Database from "better-sqlite3";
import type { Order, OrderStatus } from "@quietpay/shared";

/**
 * Internal order status. `broadcast_unknown` means a signed tx was persisted and its send failed in a way
 * that leaves it unknown whether the node accepted it; it is reported as `pending` publicly and only
 * reconciliation (receipt found, nonce used, or max age) resolves it. It is never released as unpaid.
 */
export type DbStatus = OrderStatus | "broadcast_unknown";
const UNRESOLVED = "('pending','broadcast_unknown')";

export interface OrderRow {
  id: string;
  merchant_id: string;
  amount: string;
  fee: string;
  payout: string;
  status: DbStatus;
  reference: string | null;
  webhook_url: string | null;
  nonce: string;
  payer: string | null;
  tx_hash: string | null;
  signature: string | null;
  valid_after: number | null;
  valid_before: number | null;
  failure_code: string | null;
  created_at: number;
  expires_at: number;
  settled_at: number | null;
  /** When the order was claimed for relay (unix seconds). The per-payer 24h window is measured from this. */
  relayed_at: number | null;
  /**
   * JSON snapshot of the relay fields taken by claimForRelay, so revertClaim can restore the exact
   * previous state (status, payer, signature, window, tx_hash, relayed_at, failure_code). Cleared once the
   * claim's transaction is broadcast.
   */
  claim_prev?: string | null;
  /** Random per-process token of the relayer process that holds the current claim (null for legacy rows). */
  claim_owner?: string | null;
  /** The signed pay tx (raw RLP), persisted before it is sent so a crash or timeout cannot lose it. */
  raw_tx?: string | null;
  /** The relayer-account nonce of raw_tx. */
  tx_nonce?: number | null;
  /** When raw_tx was signed and persisted (unix seconds). */
  tx_signed_at?: number | null;
  /** When reconciliation re-sent raw_tx (it does so at most once per tx). */
  rebroadcast_at?: number | null;
  /**
   * Hash of the zero-value self-transfer signed at tx_nonce to fill the nonce (the pay tx never reached the
   * node) or to cancel the pay tx (its authorization expired). Its bytes are in tx_attempts.
   */
  cancel_hash?: string | null;
  /** When the cancel was first sent (unix seconds). */
  cancel_at?: number | null;
  /** failure_code applied once the cancel has consumed the nonce (tx_not_sent or tx_not_mined). */
  cancel_code?: string | null;
}

/** One signed tx of an order: every pay attempt (also earlier, superseded ones) and every cancel. */
export interface TxAttemptRow {
  tx_hash: string;
  order_id: string;
  kind: "pay" | "cancel";
  nonce: number | null;
  gas_price: string | null;
  raw: string | null;
  signed_at: number | null;
  /** The payer whose authorization this pay tx carries (null for cancels and rows from older versions). */
  payer?: string | null;
}

/** Failure codes of orders whose tx was never seen to execute: re-checked for a late receipt. */
export const LATE_CHECK_CODES = ["tx_not_mined", "tx_dropped", "tx_not_sent"] as const;

interface ClaimSnapshot {
  status: DbStatus;
  payer: string | null;
  signature: string | null;
  valid_after: number | null;
  valid_before: number | null;
  tx_hash: string | null;
  relayed_at: number | null;
  failure_code: string | null;
  raw_tx?: string | null;
  tx_nonce?: number | null;
  tx_signed_at?: number | null;
  rebroadcast_at?: number | null;
  cancel_hash?: string | null;
  cancel_at?: number | null;
  cancel_code?: string | null;
}

export type ClaimResult = "ok" | "over_cap" | "unavailable";

export interface DeliveryRow {
  id: string;
  order_id: string;
  url: string;
  body: string;
  attempts: number;
  next_attempt_at: number;
  delivered_at: number | null;
}

export interface RefundRow {
  id: string; order_id: string; merchant_id: string; amount: string; refund_index: number;
  status: "pending" | "settled" | "failed"; signature: string; valid_after: number;
  valid_before: number; tx_hash: string | null; failure_code: string | null; created_at: number;
}

export interface AttemptRow {
  /** order_id is the work ID: a payment order ID or a refund ID. */
  hash: string; order_id: string; raw: string; nonce: number;
  gas: string; gas_price: string; sent_at: number; replacement: number;
}


export class Db {
  readonly raw: Database.Database;

  constructor(path: string | Buffer) {
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        amount TEXT NOT NULL,
        fee TEXT NOT NULL,
        payout TEXT NOT NULL,
        status TEXT NOT NULL,
        reference TEXT,
        webhook_url TEXT,
        nonce TEXT NOT NULL,
        payer TEXT,
        tx_hash TEXT,
        signature TEXT,
        valid_after INTEGER,
        valid_before INTEGER,
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        settled_at INTEGER,
        relayed_at INTEGER,
        claim_prev TEXT,
        claim_owner TEXT,
        raw_tx TEXT,
        tx_nonce INTEGER,
        tx_signed_at INTEGER,
        rebroadcast_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_payer ON orders(payer, created_at);
      CREATE TABLE IF NOT EXISTS spend (
        tx_hash TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        wei TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        url TEXT NOT NULL,
        body TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reverts (
        tx_hash TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        payer TEXT NOT NULL,
        ts INTEGER NOT NULL,
        wei TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reverts_payer ON reverts(payer, ts);
      CREATE INDEX IF NOT EXISTS idx_reverts_order ON reverts(order_id, ts);
      CREATE TABLE IF NOT EXISTS owners (token TEXT PRIMARY KEY, heartbeat INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tx_attempts (
        tx_hash TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'pay',
        nonce INTEGER,
        gas_price TEXT,
        raw TEXT,
        signed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_order ON tx_attempts(order_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_nonce ON tx_attempts(nonce);
    `);
    this.raw.exec(`      CREATE TABLE IF NOT EXISTS relay_attempts (
        hash TEXT PRIMARY KEY, order_id TEXT NOT NULL, raw TEXT NOT NULL,
        nonce INTEGER NOT NULL, gas TEXT NOT NULL, gas_price TEXT NOT NULL,
        sent_at INTEGER NOT NULL, replacement INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refunds (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL, merchant_id TEXT NOT NULL,
        amount TEXT NOT NULL, refund_index INTEGER NOT NULL, status TEXT NOT NULL,
        signature TEXT NOT NULL, valid_after INTEGER NOT NULL, valid_before INTEGER NOT NULL,
        tx_hash TEXT, failure_code TEXT, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_active ON refunds(order_id,refund_index)
        WHERE status IN ('pending','settled');
      CREATE TABLE IF NOT EXISTS x402_payments (
        id TEXT PRIMARY KEY, payer TEXT NOT NULL, nonce TEXT NOT NULL, merchant_id TEXT NOT NULL,
        resource TEXT NOT NULL, pay_to TEXT NOT NULL, amount TEXT NOT NULL, fingerprint TEXT NOT NULL, request TEXT NOT NULL,
        status TEXT NOT NULL, tx_hash TEXT UNIQUE, error_reason TEXT, created_at INTEGER NOT NULL,
        delivered_at INTEGER, delivery_attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
        UNIQUE(payer,nonce)
      );
`);
    this.migrate();
  }

  /** Idempotent migrations for databases created by older versions. */
  private migrate() {
    const cols = (this.raw.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("relayed_at")) {
      this.raw.transaction(() => {
        this.raw.exec("ALTER TABLE orders ADD COLUMN relayed_at INTEGER");
        // Backfill orders relayed before the column existed. settled_at is at or after the real relay
        // time, so it keeps old volume inside the 24h window slightly longer (the conservative side);
        // created_at is the fallback for pending/failed rows.
        this.raw.exec("UPDATE orders SET relayed_at = COALESCE(settled_at, created_at) WHERE payer IS NOT NULL AND relayed_at IS NULL");
      })();
    }
    // Additive, nullable columns: safe on a live database and on every older schema.
    for (const [name, type] of [
      ["claim_prev", "TEXT"],
      ["claim_owner", "TEXT"],
      ["raw_tx", "TEXT"],
      ["tx_nonce", "INTEGER"],
      ["tx_signed_at", "INTEGER"],
      ["rebroadcast_at", "INTEGER"],
      ["cancel_hash", "TEXT"],
      ["cancel_at", "INTEGER"],
      ["cancel_code", "TEXT"],
    ] as const) {
      if (!cols.includes(name)) this.raw.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
    }
    const attemptCols = (this.raw.prepare("PRAGMA table_info(tx_attempts)").all() as { name: string }[]).map((c) => c.name);
    if (!attemptCols.includes("payer")) {
      this.raw.transaction(() => {
        this.raw.exec("ALTER TABLE tx_attempts ADD COLUMN payer TEXT");
        // Only an order's CURRENT pay tx is known to carry the order's payer; earlier attempts stay NULL
        // (settleAttempt then keeps the order's payer, the pre-migration behaviour).
        this.raw.exec(
          `UPDATE tx_attempts SET payer = (SELECT o.payer FROM orders o WHERE o.id = tx_attempts.order_id AND o.tx_hash = tx_attempts.tx_hash)
           WHERE payer IS NULL AND kind = 'pay'`,
        );
      })();
    }
    const revertCols = (this.raw.prepare("PRAGMA table_info(reverts)").all() as { name: string }[]).map((c) => c.name);
    if (!revertCols.includes("first_time")) this.raw.exec("ALTER TABLE reverts ADD COLUMN first_time INTEGER NOT NULL DEFAULT 0");
    // Every order's current tx is part of its attempt history (rows written before tx_attempts existed).
    if (this.getSetting("tx_attempts_backfilled") !== "1") {
      this.raw.transaction(() => {
        this.raw.exec(
          `INSERT OR IGNORE INTO tx_attempts (tx_hash, order_id, kind, nonce, raw, signed_at, payer)
           SELECT tx_hash, id, 'pay', tx_nonce, raw_tx, COALESCE(tx_signed_at, relayed_at), payer FROM orders WHERE tx_hash IS NOT NULL`,
        );
        this.setSetting("tx_attempts_backfilled", "1");
      })();
    }
    this.raw.exec("CREATE INDEX IF NOT EXISTS idx_reverts_first ON reverts(first_time, ts)");
    this.raw.exec("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)");
    this.raw.exec("CREATE INDEX IF NOT EXISTS idx_orders_payer_relayed ON orders(payer, relayed_at)");
  }

  close() {
    this.raw.close();
  }

  // ---- orders
  insertOrder(r: OrderRow) {
    this.raw
      .prepare(
        `INSERT INTO orders (id, merchant_id, amount, fee, payout, status, reference, webhook_url, nonce, created_at, expires_at)
         VALUES (@id, @merchant_id, @amount, @fee, @payout, @status, @reference, @webhook_url, @nonce, @created_at, @expires_at)`,
      )
      .run(r);
  }

  getOrder(id: string): OrderRow | undefined {
    return this.raw.prepare("SELECT * FROM orders WHERE id = ?").get(id.toLowerCase()) as OrderRow | undefined;
  }

  listOrders(merchantId: string, limit = 100): OrderRow[] {
    return this.raw
      .prepare("SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(merchantId.toLowerCase(), limit) as OrderRow[];
  }

  /** Orders pending on a broadcast tx (for receipt tracking). */
  pendingOrders(): OrderRow[] {
    return this.raw.prepare("SELECT * FROM orders WHERE status = 'pending' AND tx_hash IS NOT NULL").all() as OrderRow[];
  }

  /** Every order with a signed tx whose outcome is not known yet: pending or broadcast_unknown. */
  unresolvedTxs(): OrderRow[] {
    return this.raw.prepare(`SELECT * FROM orders WHERE status IN ${UNRESOLVED} AND tx_hash IS NOT NULL`).all() as OrderRow[];
  }

  /** True if some order is unresolved on a tx signed at a nonce above `nonce` (it is queued behind it). */
  hasUnresolvedAbove(nonce: number): boolean {
    return (
      this.raw.prepare(`SELECT 1 FROM orders WHERE status IN ${UNRESOLVED} AND tx_hash IS NOT NULL AND tx_nonce > ? LIMIT 1`).get(nonce) !==
      undefined
    );
  }

  /** Orders failed as `tx_not_mined` (signed since `since`): their tx may still land, so they are re-checked. */
  notMinedFailures(since: number): OrderRow[] {
    return this.raw
      .prepare(
        "SELECT * FROM orders WHERE status IN ('failed','expired') AND failure_code='tx_not_mined' AND tx_hash IS NOT NULL AND COALESCE(tx_signed_at, relayed_at, 0)>=?",
      )
      .all(since) as OrderRow[];
  }

  /**
   * Atomic claim: only one caller moves an order from `created`/`failed` to `pending`, and only if the
   * payer's volume over [now - windowSeconds, now] plus this order stays within `payerCap`. The cap check
   * and the claim run in one IMMEDIATE transaction, so concurrent relays (in this process or another one
   * on the same database) cannot both pass the cap.
   *
   * The claim snapshots the previous relay fields into claim_prev and clears tx_hash / raw_tx (a failed
   * order otherwise keeps its old, reverted tx), so `pending AND tx_hash IS NULL` always means "claimed,
   * not yet signed", and revertClaim can restore the exact previous state. `owner` is the claiming
   * process's token; claims held by a live owner (`liveOwners`) keep counting toward the cap however old.
   */
  claimForRelay(
    id: string,
    payer: string,
    signature: string,
    validAfter: number,
    validBefore: number,
    limits: { now: number; payerCap: bigint; windowSeconds: number; claimGraceSeconds?: number; owner?: string; liveOwners?: string[] },
  ): ClaimResult {
    const tx = this.raw.transaction((): ClaimResult => {
      const row = this.getOrder(id);
      if (!row || (row.status !== "created" && row.status !== "failed") || limits.now >= row.expires_at) return "unavailable";
      const grace = limits.claimGraceSeconds ?? CLAIM_GRACE_SECONDS;
      const vol = this.payerVolume(payer, limits.now - limits.windowSeconds, limits.now - grace, limits.liveOwners ?? []);
      if (vol + BigInt(row.amount) > limits.payerCap) return "over_cap";
      const prev: ClaimSnapshot = {
        status: row.status,
        payer: row.payer,
        signature: row.signature,
        valid_after: row.valid_after,
        valid_before: row.valid_before,
        tx_hash: row.tx_hash,
        relayed_at: row.relayed_at,
        failure_code: row.failure_code,
        raw_tx: row.raw_tx ?? null,
        tx_nonce: row.tx_nonce ?? null,
        tx_signed_at: row.tx_signed_at ?? null,
        rebroadcast_at: row.rebroadcast_at ?? null,
        cancel_hash: row.cancel_hash ?? null,
        cancel_at: row.cancel_at ?? null,
        cancel_code: row.cancel_code ?? null,
      };
      // The previous attempt's hash stays in tx_attempts, so a late-landing earlier tx still settles the order.
      const r = this.raw
        .prepare(
          `UPDATE orders SET status='pending', payer=?, signature=?, valid_after=?, valid_before=?, relayed_at=?,
             tx_hash=NULL, raw_tx=NULL, tx_nonce=NULL, tx_signed_at=NULL, rebroadcast_at=NULL, failure_code=NULL,
             cancel_hash=NULL, cancel_at=NULL, cancel_code=NULL,
             claim_prev=?, claim_owner=?
           WHERE id=? AND status IN ('created','failed')`,
        )
        .run(payer.toLowerCase(), signature, validAfter, validBefore, limits.now, JSON.stringify(prev), limits.owner ?? null, id.toLowerCase());
      return r.changes === 1 ? "ok" : "unavailable";
    });
    return tx.immediate();
  }

  /**
   * Releases a claim that never reached signing, restoring the exact state from before the claim (a
   * failed order goes back to failed with its old tx, a created one to created). No-op once a tx has been
   * persisted: a signed tx is never released as unpaid. With `expectOwner` (a token, or null for an
   * ownerless legacy claim) the release only applies while that owner still holds the claim. Returns true
   * if a claim was released.
   */
  revertClaim(id: string, expectOwner?: string | null): boolean {
    const tx = this.raw.transaction((): boolean => {
      const row = this.getOrder(id);
      if (!row || row.status !== "pending" || row.tx_hash !== null) return false;
      if (expectOwner !== undefined && (row.claim_owner ?? null) !== expectOwner) return false;
      let prev: ClaimSnapshot | null = null;
      try {
        prev = row.claim_prev ? (JSON.parse(row.claim_prev) as ClaimSnapshot) : null;
      } catch {
        prev = null;
      }
      // A claim without a snapshot predates claim_prev; those only ever came from `created` rows.
      const p: ClaimSnapshot = prev ?? {
        status: "created",
        payer: null,
        signature: null,
        valid_after: null,
        valid_before: null,
        tx_hash: null,
        relayed_at: null,
        failure_code: row.failure_code,
      };
      // Only created/failed can be restored; anything else in a snapshot is corrupt and falls back to created.
      const status = p.status === "failed" ? "failed" : "created";
      const r = this.raw
        .prepare(
          `UPDATE orders SET status=?, payer=?, signature=?, valid_after=?, valid_before=?, tx_hash=?, relayed_at=?,
             failure_code=?, raw_tx=?, tx_nonce=?, tx_signed_at=?, rebroadcast_at=?, cancel_hash=?, cancel_at=?, cancel_code=?,
             claim_prev=NULL, claim_owner=NULL
           WHERE id=? AND status='pending' AND tx_hash IS NULL AND claim_owner IS ?`,
        )
        .run(
          status,
          p.payer,
          p.signature,
          p.valid_after,
          p.valid_before,
          p.tx_hash,
          p.relayed_at,
          p.failure_code,
          p.raw_tx ?? null,
          p.tx_nonce ?? null,
          p.tx_signed_at ?? null,
          p.rebroadcast_at ?? null,
          p.cancel_hash ?? null,
          p.cancel_at ?? null,
          p.cancel_code ?? null,
          row.id,
          row.claim_owner ?? null,
        );
      return r.changes === 1;
    });
    return tx.immediate();
  }

  /** Claims that never reached signing (pending, no tx_hash) made before `claimedBefore` (unix seconds). */
  staleClaims(claimedBefore: number): OrderRow[] {
    return this.raw
      .prepare("SELECT * FROM orders WHERE status='pending' AND tx_hash IS NULL AND (relayed_at IS NULL OR relayed_at<?)")
      .all(claimedBefore) as OrderRow[];
  }

  /**
   * Persists a locally signed tx on its claim BEFORE it is sent. Applies only while the order is still a
   * pending, unsigned claim held by `owner` (null matches a legacy ownerless claim), so a process whose
   * claim was released and taken over cannot attach (or then send) a second tx. Returns true on success.
   */
  persistSignedTx(
    id: string,
    owner: string | null,
    tx: { hash: string; raw: string; nonce: number; gasPrice?: bigint },
    now: number,
  ): boolean {
    return this.raw.transaction((): boolean => {
      const r = this.raw
        .prepare(
          `UPDATE orders SET tx_hash=?, raw_tx=?, tx_nonce=?, tx_signed_at=?, rebroadcast_at=NULL, claim_prev=NULL
           WHERE id=? AND status='pending' AND tx_hash IS NULL AND claim_owner IS ?`,
        )
        .run(tx.hash, tx.raw, tx.nonce, now, id.toLowerCase(), owner);
      if (r.changes !== 1) return false;
      const payer = this.getOrder(id)?.payer ?? null;
      this.insertAttempt({ tx_hash: tx.hash, order_id: id, kind: "pay", nonce: tx.nonce, gas_price: tx.gasPrice?.toString() ?? null, raw: tx.raw, signed_at: now, payer });
      return true;
    }).immediate();
  }

  /** Records a tx hash on an owned, unsigned claim (no raw bytes). Prefer persistSignedTx. */
  setTxHash(id: string, txHash: string, owner: string | null = null): boolean {
    const r = this.raw
      .prepare("UPDATE orders SET tx_hash=?, claim_prev=NULL WHERE id=? AND status='pending' AND tx_hash IS NULL AND claim_owner IS ?")
      .run(txHash, id.toLowerCase(), owner);
    if (r.changes === 1) {
      const payer = this.getOrder(id)?.payer ?? null;
      this.insertAttempt({ tx_hash: txHash, order_id: id, kind: "pay", nonce: null, gas_price: null, raw: null, signed_at: null, payer });
    }
    return r.changes === 1;
  }

  // ---- tx attempt history (pay attempts and cancels)
  private insertAttempt(a: TxAttemptRow) {
    this.raw
      .prepare("INSERT OR IGNORE INTO tx_attempts (tx_hash, order_id, kind, nonce, gas_price, raw, signed_at, payer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.tx_hash, a.order_id.toLowerCase(), a.kind, a.nonce, a.gas_price, a.raw, a.signed_at, a.payer?.toLowerCase() ?? null);
  }

  getAttempt(txHash: string): TxAttemptRow | undefined {
    return this.raw.prepare("SELECT * FROM tx_attempts WHERE tx_hash=?").get(txHash) as TxAttemptRow | undefined;
  }

  /** Every pay tx ever signed for this order, oldest first (includes superseded earlier attempts). */
  payAttempts(orderId: string): TxAttemptRow[] {
    return this.raw
      .prepare("SELECT * FROM tx_attempts WHERE order_id=? AND kind='pay' ORDER BY COALESCE(signed_at, 0), rowid")
      .all(orderId.toLowerCase()) as TxAttemptRow[];
  }

  /**
   * True if another tx of ours (a pay attempt of a different hash, on an order that is still unresolved)
   * was signed at this nonce: after a nonce resync that tx may be the one filling it, and a cancel at the
   * same nonce would replace an innocent payment.
   */
  nonceTakenByOther(nonce: number, exceptHash: string): boolean {
    const r = this.raw
      .prepare(
        `SELECT 1 FROM tx_attempts a JOIN orders o ON o.id = a.order_id
         WHERE a.nonce=? AND a.tx_hash<>? AND a.kind='pay' AND o.status IN ${UNRESOLVED} AND o.tx_hash = a.tx_hash LIMIT 1`,
      )
      .get(nonce, exceptHash);
    const extension = this.raw.prepare(`SELECT 1 FROM relay_attempts a
      WHERE a.nonce=? AND a.hash<>? AND (
        EXISTS (SELECT 1 FROM refunds r WHERE r.id=a.order_id AND r.status='pending') OR
        EXISTS (SELECT 1 FROM x402_payments x WHERE x.id=a.order_id AND x.status='settling')) LIMIT 1`).get(nonce, exceptHash);
    return r !== undefined || extension !== undefined;
  }

  /**
   * Persists a signed cancel / gap-filling tx for an unresolved order on exactly `txHash` (before it is
   * sent). Applies once per order attempt. Returns true if recorded.
   */
  recordCancel(id: string, txHash: string, cancel: { hash: string; raw: string; nonce: number; gasPrice: bigint }, code: string, now: number): boolean {
    return this.raw.transaction((): boolean => {
      const r = this.raw
        .prepare(`UPDATE orders SET cancel_hash=?, cancel_at=?, cancel_code=? WHERE id=? AND status IN ${UNRESOLVED} AND tx_hash=? AND cancel_hash IS NULL`)
        .run(cancel.hash, now, code, id.toLowerCase(), txHash);
      if (r.changes !== 1) return false;
      this.insertAttempt({ tx_hash: cancel.hash, order_id: id, kind: "cancel", nonce: cancel.nonce, gas_price: cancel.gasPrice.toString(), raw: cancel.raw, signed_at: now });
      return true;
    }).immediate();
  }

  /**
   * Settles an order on one of its own pay attempts (`txHash` must be the current tx or an earlier attempt of
   * this order), from any not-yet-settled state: a receipt with status success for a pay tx of this order
   * proves it was paid on chain. The order's tx_hash becomes the settling hash, and its payer becomes the payer
   * of that attempt (a later claimant whose retry reverted is not credited with the payment, its cap and
   * repeat-payer status are not affected, and the webhook names the wallet that paid). Returns true once.
   */
  settleAttempt(id: string, txHash: string, settledAt: number): boolean {
    const r = this.raw
      .prepare(
        `UPDATE orders SET status='settled', tx_hash=?, failure_code=NULL, settled_at=?,
           payer=COALESCE((SELECT a.payer FROM tx_attempts a WHERE a.order_id=orders.id AND a.tx_hash=? AND a.kind='pay'), payer)
         WHERE id=? AND status IN ('pending','broadcast_unknown','failed','expired')
           AND (tx_hash=? OR EXISTS (SELECT 1 FROM tx_attempts a WHERE a.order_id=orders.id AND a.tx_hash=? AND a.kind='pay'))`,
      )
      .run(txHash, settledAt, txHash, id.toLowerCase(), txHash, txHash);
    return r.changes === 1;
  }

  /** Orders failed (or since expired) because their tx was not seen to execute, signed since `since`. */
  lateCheckFailures(since: number): OrderRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM orders WHERE status IN ('failed','expired') AND failure_code IN (${LATE_CHECK_CODES.map(() => "?").join(",")})
           AND tx_hash IS NOT NULL AND COALESCE(tx_signed_at, relayed_at, 0)>=?`,
      )
      .all(...LATE_CHECK_CODES, since) as OrderRow[];
  }

  /** True if this payer has at least one settled order (a repeat payer). */
  hasSettlement(payer: string): boolean {
    return this.raw.prepare("SELECT 1 FROM orders WHERE payer=? AND status IN ('settled','partially_refunded','refunded') LIMIT 1").get(payer.toLowerCase()) !== undefined;
  }

  /** pending -> broadcast_unknown for exactly this tx. */
  markBroadcastUnknown(id: string, txHash: string): boolean {
    return (
      this.raw.prepare("UPDATE orders SET status='broadcast_unknown' WHERE id=? AND status='pending' AND tx_hash=?").run(id.toLowerCase(), txHash)
        .changes === 1
    );
  }

  /** broadcast_unknown -> pending once the node is known to have exactly this tx. */
  markBroadcastKnown(id: string, txHash: string): boolean {
    return (
      this.raw.prepare("UPDATE orders SET status='pending' WHERE id=? AND status='broadcast_unknown' AND tx_hash=?").run(id.toLowerCase(), txHash)
        .changes === 1
    );
  }

  /** Records the single rebroadcast of an unresolved tx. Returns false if one was already recorded. */
  markRebroadcast(id: string, txHash: string, now: number): boolean {
    return (
      this.raw
        .prepare(`UPDATE orders SET rebroadcast_at=? WHERE id=? AND status IN ${UNRESOLVED} AND tx_hash=? AND rebroadcast_at IS NULL`)
        .run(now, id.toLowerCase(), txHash).changes === 1
    );
  }

  /**
   * Records the outcome of a signed tx. Applies only while the order is still unresolved (pending or
   * broadcast_unknown) on exactly this hash, so a stale or duplicate tracker / reconciler cannot overwrite a
   * newer attempt or emit a second event. Returns true if this call made the transition.
   */
  finishTx(id: string, txHash: string, outcome: "settled" | "failed", extra: { failureCode?: string; settledAt?: number } = {}): boolean {
    const r = this.raw
      .prepare(
        `UPDATE orders SET status=?, failure_code=COALESCE(?, failure_code), settled_at=COALESCE(?, settled_at)
         WHERE id=? AND status IN ${UNRESOLVED} AND tx_hash=?`,
      )
      .run(outcome, extra.failureCode ?? null, extra.settledAt ?? null, id.toLowerCase(), txHash);
    return r.changes === 1;
  }

  /** A tx we gave up on as `tx_not_mined` was mined after all: failed/expired -> settled, once. */
  lateSettle(id: string, txHash: string, settledAt: number): boolean {
    const r = this.raw
      .prepare(
        `UPDATE orders SET status='settled', failure_code=NULL, settled_at=?
         WHERE id=? AND status IN ('failed','expired') AND failure_code='tx_not_mined' AND tx_hash=?`,
      )
      .run(settledAt, id.toLowerCase(), txHash);
    return r.changes === 1;
  }

  /**
   * Compare-and-set status change: applies only if the order is currently in one of `from`. Returns true
   * if this call made the transition. Every status change outside the claim/tx paths goes through here.
   */
  transition(id: string, from: DbStatus[], to: DbStatus, extra?: { failureCode?: string; settledAt?: number }): boolean {
    if (from.length === 0) return false;
    const r = this.raw
      .prepare(
        `UPDATE orders SET status=?,
           failure_code=CASE WHEN ?='settled' THEN NULL ELSE COALESCE(?, failure_code) END,
           settled_at=COALESCE(?, settled_at)
         WHERE id=? AND status IN (${from.map(() => "?").join(",")})`,
      )
      .run(to, to, extra?.failureCode ?? null, extra?.settledAt ?? null, id.toLowerCase(), ...from);
    return r.changes === 1;
  }

  /**
   * Sum of amounts this payer has moved or is moving, relayed since `since` (unix seconds): settled
   * orders, orders with a signed tx still unresolved (pending / broadcast_unknown), and claims not yet
   * signed that are either younger than `inflightSince` or held by a live owner (`liveOwners`). A claim
   * still being worked on must keep counting however slow the RPC is; only a claim with no live owner and
   * older than the grace is a crashed attempt that moved nothing (releaseStaleClaims frees it).
   * Rejected attempts are reverted to their previous state, so they never count.
   */
  payerVolume(payer: string, since: number, inflightSince: number = since, liveOwners: string[] = []): bigint {
    const owners = liveOwners.length ? `OR claim_owner IN (${liveOwners.map(() => "?").join(",")})` : "";
    const rows = this.raw
      .prepare(
        `SELECT amount FROM orders WHERE payer=? AND relayed_at>=? AND (
           status IN ('settled','partially_refunded','refunded') OR (status IN ${UNRESOLVED} AND (tx_hash IS NOT NULL OR relayed_at>=? ${owners})))`,
      )
      .all(payer.toLowerCase(), since, inflightSince, ...liveOwners) as { amount: string }[];
    const agents = this.raw.prepare("SELECT amount FROM x402_payments WHERE payer=? AND status IN ('settling','settled') AND created_at>=?").all(payer.toLowerCase(), since) as { amount: string }[];
    return [...rows, ...agents].reduce((a, r) => a + BigInt(r.amount), 0n);
  }

  // ---- reverts (payer-caused on-chain failures)
  /** `firstTime`: the payer had no settled order when the revert happened (defaults to looking it up now). */
  recordRevert(r: { txHash: string; orderId: string; payer: string; ts: number; wei: bigint; firstTime?: boolean }) {
    const firstTime = r.firstTime ?? !this.hasSettlement(r.payer);
    this.raw
      .prepare("INSERT OR IGNORE INTO reverts (tx_hash, order_id, payer, ts, wei, first_time) VALUES (?, ?, ?, ?, ?, ?)")
      .run(r.txHash, r.orderId.toLowerCase(), r.payer.toLowerCase(), r.ts, r.wei.toString(), firstTime ? 1 : 0);
  }

  /** Gas burnt (wei) since `since` by reverts of payers who had no settled order at the time. */
  firstTimeRevertWei(since: number): bigint {
    const rows = this.raw.prepare("SELECT wei FROM reverts WHERE first_time=1 AND ts>=?").all(since) as { wei: string }[];
    return rows.reduce((a, r) => a + BigInt(r.wei), 0n);
  }

  /** Reverts caused by this payer since `since`: count, most recent time, and gas burnt (wei). */
  revertStats(payer: string, since: number): { count: number; last: number | null; wei: bigint } {
    const rows = this.raw.prepare("SELECT ts, wei FROM reverts WHERE payer=? AND ts>=?").all(payer.toLowerCase(), since) as { ts: number; wei: string }[];
    return {
      count: rows.length,
      last: rows.length ? Math.max(...rows.map((r) => r.ts)) : null,
      wei: rows.reduce((a, r) => a + BigInt(r.wei), 0n),
    };
  }

  /**
   * This payer's signed txs whose outcome is not known yet (pending / broadcast_unknown, any age): how many, and
   * the gas estimate recorded for each when it was signed (spend table). Every one of them may still revert, so
   * the per-payer revert limits count them as potential reverts / potential loss.
   */
  unresolvedPayerTxs(payer: string): { count: number; wei: bigint } {
    const rows = this.raw
      .prepare(
        `SELECT COALESCE(s.wei, '0') wei FROM orders o LEFT JOIN spend s ON s.tx_hash = o.tx_hash
         WHERE o.payer=? AND o.status IN ${UNRESOLVED} AND o.tx_hash IS NOT NULL`,
      )
      .all(payer.toLowerCase()) as { wei: string }[];
    return { count: rows.length, wei: rows.reduce((a, r) => a + BigInt(r.wei), 0n) };
  }

  orderRevertCount(orderId: string, since: number): number {
    return (this.raw.prepare("SELECT COUNT(*) c FROM reverts WHERE order_id=? AND ts>=?").get(orderId.toLowerCase(), since) as { c: number }).c;
  }

  // ---- process ownership (claims)
  heartbeat(token: string, now: number) {
    this.raw.prepare("INSERT INTO owners (token, heartbeat) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET heartbeat=excluded.heartbeat").run(token, now);
  }

  /** Owner tokens that heartbeated at or after `since`. */
  liveOwners(since: number): string[] {
    return (this.raw.prepare("SELECT token FROM owners WHERE heartbeat>=?").all(since) as { token: string }[]).map((r) => r.token);
  }

  removeOwner(token: string) {
    this.raw.prepare("DELETE FROM owners WHERE token=?").run(token);
  }

  countByStatus(): Record<string, number> {
    const rows = this.raw.prepare("SELECT status, COUNT(*) c FROM orders GROUP BY status").all() as { status: string; c: number }[];
    const out: Record<string, number> = {};
    // broadcast_unknown is internal; it is reported as pending.
    for (const r of rows) {
      const k = r.status === "broadcast_unknown" ? "pending" : r.status;
      out[k] = (out[k] ?? 0) + r.c;
    }
    return out;
  }

  // ---- gas spend (loss budget)
  recordSpend(txHash: string, ts: number, wei: bigint) {
    this.raw
      .prepare("INSERT INTO spend (tx_hash, ts, wei) VALUES (?, ?, ?) ON CONFLICT(tx_hash) DO UPDATE SET wei=excluded.wei")
      .run(txHash, ts, wei.toString());
  }

  spentSince(since: number): bigint {
    const rows = this.raw.prepare("SELECT wei FROM spend WHERE ts>=?").all(since) as { wei: string }[];
    return rows.reduce((a, r) => a + BigInt(r.wei), 0n);
  }

  attempts(orderId: string): AttemptRow[] {
    return this.raw.prepare("SELECT * FROM relay_attempts WHERE order_id=? ORDER BY rowid").all(orderId) as AttemptRow[];
  }

  nonceFloor(): number {
    return (this.raw.prepare("SELECT COALESCE(MAX(nonce)+1,0) n FROM (SELECT nonce FROM relay_attempts UNION ALL SELECT nonce FROM tx_attempts)").get() as { n: number }).n;
  }

  saveAttempt(a: AttemptRow, target: "orders" | "refunds" | "x402_payments" = "orders") {
    this.raw.transaction(() => {
      this.raw.prepare(`INSERT INTO relay_attempts VALUES (@hash,@order_id,@raw,@nonce,@gas,@gas_price,@sent_at,@replacement)`).run(a);
      this.raw.prepare(`UPDATE ${target} SET tx_hash=? WHERE id=?`).run(a.hash, a.order_id);
      const previous = this.attempts(a.order_id).filter(x => x.nonce === a.nonce && x.hash !== a.hash);
      for (const old of previous) this.raw.prepare("DELETE FROM spend WHERE tx_hash=?").run(old.hash);
      this.recordSpend(a.hash, a.sent_at, BigInt(a.gas) * BigInt(a.gas_price));
    })();
  }

  reservedSpend(since: number): bigint {
    const rows = this.raw.prepare(`SELECT s.wei FROM spend s WHERE s.ts>=? OR EXISTS
      (SELECT 1 FROM orders o WHERE o.status IN ('pending','broadcast_unknown') AND o.tx_hash=s.tx_hash) OR EXISTS (SELECT 1 FROM refunds r WHERE r.status='pending' AND r.tx_hash=s.tx_hash) OR EXISTS (SELECT 1 FROM x402_payments x WHERE x.status='settling' AND x.tx_hash=s.tx_hash)`).all(since) as { wei: string }[];
    return rows.reduce((sum, r) => sum + BigInt(r.wei), 0n);
  }

  getRefund(id: string): RefundRow | undefined {
    return this.raw.prepare("SELECT * FROM refunds WHERE id=?").get(id.toLowerCase()) as RefundRow | undefined;
  }
  pendingRefunds(): RefundRow[] {
    return this.raw.prepare("SELECT * FROM refunds WHERE status='pending'").all() as RefundRow[];
  }
  insertRefund(r: RefundRow) {
    this.raw.prepare(`INSERT INTO refunds VALUES (@id,@order_id,@merchant_id,@amount,@refund_index,@status,
      @signature,@valid_after,@valid_before,@tx_hash,@failure_code,@created_at)`).run(r);
  }
  refundTotals(orderId: string) {
    const rows = this.raw.prepare("SELECT amount FROM refunds WHERE order_id=? AND status='settled'").all(orderId) as { amount: string }[];
    return { amount: rows.reduce((v,r) => v + BigInt(r.amount), 0n), count: rows.length };
  }


  // ---- settings
  getSetting(key: string): string | undefined {
    return (this.raw.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  setSetting(key: string, value: string) {
    this.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  // ---- webhook deliveries
  insertDelivery(d: DeliveryRow) {
    this.raw
      .prepare("INSERT OR IGNORE INTO deliveries (id, order_id, url, body, attempts, next_attempt_at) VALUES (@id, @order_id, @url, @body, @attempts, @next_attempt_at)")
      .run(d);
  }
  dueDeliveries(now: number, limit = 20): DeliveryRow[] {
    return this.raw
      .prepare("SELECT * FROM deliveries WHERE delivered_at IS NULL AND next_attempt_at<=? AND attempts<? ORDER BY next_attempt_at LIMIT ?")
      .all(now, MAX_DELIVERY_ATTEMPTS, limit) as DeliveryRow[];
  }
  markDelivered(id: string, now: number) {
    this.raw.prepare("UPDATE deliveries SET delivered_at=? WHERE id=?").run(now, id);
  }
  markAttempt(id: string, nextAt: number) {
    this.raw.prepare("UPDATE deliveries SET attempts=attempts+1, next_attempt_at=? WHERE id=?").run(nextAt, id);
  }
  getDelivery(id: string): DeliveryRow | undefined {
    return this.raw.prepare("SELECT * FROM deliveries WHERE id=?").get(id) as DeliveryRow | undefined;
  }
}

export const MAX_DELIVERY_ATTEMPTS = 7;
/** A claim still without a tx hash after this many seconds is a dead attempt (crashed before broadcast). */
export const CLAIM_GRACE_SECONDS = 120;
/**
 * A process whose heartbeat is older than this is presumed dead; its unsigned claims may be released.
 * Live processes heartbeat on every relay and every reconcile tick (30 s by default).
 */
export const OWNER_TIMEOUT_SECONDS = 300;
/** Backoff seconds after the Nth failed attempt (1-indexed). */
export const DELIVERY_BACKOFF_SECONDS = [5, 30, 120, 600, 1800, 3600, 7200];

export function rowToOrder(r: OrderRow, ctx: { router: string; token: string; chainId: number; domain: { name: string; version: string }; explorerBaseUrl: string }): Order {
  return {
    id: r.id as `0x${string}`,
    merchantId: r.merchant_id as `0x${string}`,
    amount: r.amount,
    status: r.status === "broadcast_unknown" ? "pending" : r.status,
    reference: r.reference ?? undefined,
    payout: r.payout,
    fee: r.fee,
    payer: (r.payer as `0x${string}` | null) ?? undefined,
    txHash: (r.tx_hash as `0x${string}` | null) ?? undefined,
    failureCode: r.failure_code ?? undefined,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    settledAt: r.settled_at ?? undefined,
    explorerUrl: r.tx_hash ? `${ctx.explorerBaseUrl}/tx/${r.tx_hash}` : undefined,
    checkout: {
      chainId: ctx.chainId,
      token: ctx.token,
      router: ctx.router,
      value: r.amount,
      nonce: r.nonce,
      payout: r.payout,
      fee: r.fee,
      domain: ctx.domain,
    },
  };
}
