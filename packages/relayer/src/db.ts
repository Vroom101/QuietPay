import Database from "better-sqlite3";
import type { Order, OrderStatus } from "@quietpay/shared";

export interface OrderRow {
  id: string;
  merchant_id: string;
  amount: string;
  fee: string;
  payout: string;
  status: OrderStatus;
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
}

interface ClaimSnapshot {
  status: OrderStatus;
  payer: string | null;
  signature: string | null;
  valid_after: number | null;
  valid_before: number | null;
  tx_hash: string | null;
  relayed_at: number | null;
  failure_code: string | null;
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

export class Db {
  readonly raw: Database.Database;

  constructor(path: string) {
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
        claim_prev TEXT
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
    if (!cols.includes("claim_prev")) this.raw.exec("ALTER TABLE orders ADD COLUMN claim_prev TEXT");
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

  pendingOrders(): OrderRow[] {
    return this.raw.prepare("SELECT * FROM orders WHERE status = 'pending' AND tx_hash IS NOT NULL").all() as OrderRow[];
  }

  /**
   * Atomic claim: only one caller moves an order from `created`/`failed` to `pending`, and only if the
   * payer's volume over [now - windowSeconds, now] plus this order stays within `payerCap`. The cap check
   * and the claim run in one IMMEDIATE transaction, so concurrent relays (in this process or another one
   * on the same database) cannot both pass the cap.
   *
   * The claim snapshots the previous relay fields into claim_prev and clears tx_hash (a failed order
   * otherwise keeps its old, reverted hash), so `pending AND tx_hash IS NULL` always means "claimed, not
   * yet broadcast", and revertClaim can restore the exact previous state.
   */
  claimForRelay(
    id: string,
    payer: string,
    signature: string,
    validAfter: number,
    validBefore: number,
    limits: { now: number; payerCap: bigint; windowSeconds: number; claimGraceSeconds?: number },
  ): ClaimResult {
    const tx = this.raw.transaction((): ClaimResult => {
      const row = this.getOrder(id);
      if (!row || (row.status !== "created" && row.status !== "failed") || limits.now >= row.expires_at) return "unavailable";
      const grace = limits.claimGraceSeconds ?? CLAIM_GRACE_SECONDS;
      const vol = this.payerVolume(payer, limits.now - limits.windowSeconds, limits.now - grace);
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
      };
      const r = this.raw
        .prepare(
          `UPDATE orders SET status='pending', payer=?, signature=?, valid_after=?, valid_before=?, relayed_at=?,
             tx_hash=NULL, failure_code=NULL, claim_prev=?
           WHERE id=? AND status IN ('created','failed')`,
        )
        .run(payer.toLowerCase(), signature, validAfter, validBefore, limits.now, JSON.stringify(prev), id.toLowerCase());
      return r.changes === 1 ? "ok" : "unavailable";
    });
    return tx.immediate();
  }

  /**
   * Releases a claim that never reached broadcast, restoring the exact state from before the claim (a
   * failed order goes back to failed with its old tx_hash, a created one to created). No-op once a tx
   * hash has been recorded. Returns true if a claim was released.
   */
  revertClaim(id: string): boolean {
    const tx = this.raw.transaction((): boolean => {
      const row = this.getOrder(id);
      if (!row || row.status !== "pending" || row.tx_hash !== null) return false;
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
      const r = this.raw
        .prepare(
          `UPDATE orders SET status=?, payer=?, signature=?, valid_after=?, valid_before=?, tx_hash=?, relayed_at=?,
             failure_code=?, claim_prev=NULL
           WHERE id=? AND status='pending' AND tx_hash IS NULL`,
        )
        .run(p.status, p.payer, p.signature, p.valid_after, p.valid_before, p.tx_hash, p.relayed_at, p.failure_code, row.id);
      return r.changes === 1;
    });
    return tx.immediate();
  }

  /** Claims that never reached broadcast (pending, no tx_hash) made before `claimedBefore` (unix seconds). */
  staleClaims(claimedBefore: number): OrderRow[] {
    return this.raw
      .prepare("SELECT * FROM orders WHERE status='pending' AND tx_hash IS NULL AND (relayed_at IS NULL OR relayed_at<?)")
      .all(claimedBefore) as OrderRow[];
  }

  setTxHash(id: string, txHash: string) {
    this.raw.prepare("UPDATE orders SET tx_hash=?, claim_prev=NULL WHERE id=?").run(txHash, id.toLowerCase());
  }

  /**
   * Records the receipt outcome of a broadcast tx. Applies only while the order is still pending on
   * exactly this hash, so a stale or duplicate tracker cannot overwrite a newer attempt or emit a second
   * event. Returns true if this call made the transition.
   */
  finishTx(id: string, txHash: string, outcome: "settled" | "failed", extra: { failureCode?: string; settledAt?: number } = {}): boolean {
    const r = this.raw
      .prepare(
        `UPDATE orders SET status=?, failure_code=COALESCE(?, failure_code), settled_at=COALESCE(?, settled_at)
         WHERE id=? AND status='pending' AND tx_hash=?`,
      )
      .run(outcome, extra.failureCode ?? null, extra.settledAt ?? null, id.toLowerCase(), txHash);
    return r.changes === 1;
  }

  setStatus(id: string, status: OrderStatus, extra?: { failureCode?: string; settledAt?: number }) {
    this.raw
      .prepare("UPDATE orders SET status=?, failure_code=COALESCE(?, failure_code), settled_at=COALESCE(?, settled_at) WHERE id=?")
      .run(status, extra?.failureCode ?? null, extra?.settledAt ?? null, id.toLowerCase());
  }

  /**
   * Sum of amounts this payer has moved or is moving, relayed since `since` (unix seconds): settled
   * orders, pending orders with a broadcast tx, and in-flight claims (pending, no tx yet) made at or after
   * `inflightSince`. In-flight claims must count so concurrent relays cannot both pass the cap; an older
   * claim with no tx is a crashed attempt that moved nothing and is ignored (releaseStaleClaims frees it).
   * Rejected attempts are reverted to their previous state, so they never count.
   */
  payerVolume(payer: string, since: number, inflightSince: number = since): bigint {
    const rows = this.raw
      .prepare(
        `SELECT amount FROM orders WHERE payer=? AND relayed_at>=? AND (
           status='settled' OR (status='pending' AND (tx_hash IS NOT NULL OR relayed_at>=?)))`,
      )
      .all(payer.toLowerCase(), since, inflightSince) as { amount: string }[];
    return rows.reduce((a, r) => a + BigInt(r.amount), 0n);
  }

  countByStatus(): Record<string, number> {
    const rows = this.raw.prepare("SELECT status, COUNT(*) c FROM orders GROUP BY status").all() as { status: string; c: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
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
  dueDeliveries(now: number): DeliveryRow[] {
    return this.raw
      .prepare("SELECT * FROM deliveries WHERE delivered_at IS NULL AND next_attempt_at<=? AND attempts<? ORDER BY next_attempt_at LIMIT 20")
      .all(now, MAX_DELIVERY_ATTEMPTS) as DeliveryRow[];
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
/** Backoff seconds after the Nth failed attempt (1-indexed). */
export const DELIVERY_BACKOFF_SECONDS = [5, 30, 120, 600, 1800, 3600, 7200];

export function rowToOrder(r: OrderRow, ctx: { router: string; token: string; chainId: number; domain: { name: string; version: string }; explorerBaseUrl: string }): Order {
  return {
    id: r.id as `0x${string}`,
    merchantId: r.merchant_id as `0x${string}`,
    amount: r.amount,
    status: r.status,
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
