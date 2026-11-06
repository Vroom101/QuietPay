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
        relayed_at INTEGER
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
   */
  claimForRelay(
    id: string,
    payer: string,
    signature: string,
    validAfter: number,
    validBefore: number,
    limits: { now: number; payerCap: bigint; windowSeconds: number },
  ): ClaimResult {
    const tx = this.raw.transaction((): ClaimResult => {
      const row = this.getOrder(id);
      if (!row || (row.status !== "created" && row.status !== "failed") || limits.now >= row.expires_at) return "unavailable";
      if (this.payerVolume(payer, limits.now - limits.windowSeconds) + BigInt(row.amount) > limits.payerCap) return "over_cap";
      const r = this.raw
        .prepare(
          `UPDATE orders SET status='pending', payer=?, signature=?, valid_after=?, valid_before=?, relayed_at=?
           WHERE id=? AND status IN ('created','failed')`,
        )
        .run(payer.toLowerCase(), signature, validAfter, validBefore, limits.now, id.toLowerCase());
      return r.changes === 1 ? "ok" : "unavailable";
    });
    return tx.immediate();
  }

  revertClaim(id: string) {
    this.raw
      .prepare(
        "UPDATE orders SET status='created', payer=NULL, signature=NULL, valid_after=NULL, valid_before=NULL, relayed_at=NULL WHERE id=? AND status='pending' AND tx_hash IS NULL",
      )
      .run(id.toLowerCase());
  }

  setTxHash(id: string, txHash: string) {
    this.raw.prepare("UPDATE orders SET tx_hash=? WHERE id=?").run(txHash, id.toLowerCase());
  }

  setStatus(id: string, status: OrderStatus, extra?: { failureCode?: string; settledAt?: number }) {
    this.raw
      .prepare("UPDATE orders SET status=?, failure_code=COALESCE(?, failure_code), settled_at=COALESCE(?, settled_at) WHERE id=?")
      .run(status, extra?.failureCode ?? null, extra?.settledAt ?? null, id.toLowerCase());
  }

  /** Sum of amounts this payer has pending or settled, relayed since `since` (unix seconds). */
  payerVolume(payer: string, since: number): bigint {
    const rows = this.raw
      .prepare("SELECT amount FROM orders WHERE payer=? AND status IN ('pending','settled') AND relayed_at>=?")
      .all(payer.toLowerCase(), since) as { amount: string }[];
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
