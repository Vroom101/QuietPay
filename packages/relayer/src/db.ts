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
}

export interface RefundRow {
  id: string; order_id: string; merchant_id: string; amount: string; refund_index: number;
  status: "pending" | "settled" | "failed"; signature: string; valid_after: number;
  valid_before: number; tx_hash: string | null; failure_code: string | null; created_at: number;
}

export interface DeliveryRow {
  id: string;
  order_id: string;
  url: string;
  body: string;
  attempts: number;
  next_attempt_at: number;
  delivered_at: number | null;
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
        settled_at INTEGER
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
      CREATE TABLE IF NOT EXISTS relay_attempts (
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
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const columns = this.raw.pragma("table_info(orders)") as { name: string }[];
    if (!columns.some(c => c.name === "payer_volume_at")) this.raw.exec("ALTER TABLE orders ADD COLUMN payer_volume_at INTEGER");
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
    return this.raw.prepare("SELECT * FROM orders WHERE status = 'pending'").all() as OrderRow[];
  }

  /** Atomic claim: only one caller moves an order from `created` to `pending`. */
  claimForRelay(id: string, payer: string, signature: string, validAfter: number, validBefore: number, now = Math.floor(Date.now() / 1000)): boolean {
    const r = this.raw
      .prepare(
        `UPDATE orders SET status='pending', payer=?, signature=?, valid_after=?, valid_before=?, tx_hash=NULL, failure_code=NULL, payer_volume_at=?
         WHERE id=? AND status IN ('created','failed')`,
      )
      .run(payer.toLowerCase(), signature, validAfter, validBefore, now, id.toLowerCase());
    return r.changes === 1;
  }

  revertClaim(id: string) {
    this.raw
      .prepare("UPDATE orders SET status='created', payer=NULL, signature=NULL, valid_after=NULL, valid_before=NULL WHERE id=? AND status='pending' AND tx_hash IS NULL")
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

  /** Sum of amounts this payer has pending or settled since `since` (unix seconds). */
  payerVolume(payer: string, since: number): bigint {
    const rows = this.raw
      .prepare("SELECT amount FROM orders WHERE payer=? AND status IN ('pending','settled','partially_refunded','refunded') AND COALESCE(payer_volume_at,created_at)>=?")
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
      .prepare("INSERT INTO spend (tx_hash, ts, wei) VALUES (?, ?, ?) ON CONFLICT(tx_hash) DO UPDATE SET wei=excluded.wei, ts=excluded.ts")
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
    return (this.raw.prepare("SELECT COALESCE(MAX(nonce)+1,0) n FROM relay_attempts").get() as { n: number }).n;
  }

  saveAttempt(a: AttemptRow, target: "orders" | "refunds" = "orders") {
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
      (SELECT 1 FROM orders o WHERE o.status='pending' AND o.tx_hash=s.tx_hash) OR EXISTS (SELECT 1 FROM refunds r WHERE r.status='pending' AND r.tx_hash=s.tx_hash)`).all(since) as { wei: string }[];
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
