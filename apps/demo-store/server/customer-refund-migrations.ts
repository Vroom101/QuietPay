import type Database from "better-sqlite3";

/** Additive and idempotent: creates the customer refund status tables if they do not exist. */
export function migrateCustomerRefunds(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_access (
      order_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rotated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS order_refund_state (
      order_id TEXT PRIMARY KEY,
      amount_paid TEXT NOT NULL,
      total_refunded TEXT NOT NULL DEFAULT '0',
      status_rank INTEGER NOT NULL DEFAULT 0,
      last_sync_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS customer_refunds (
      order_id TEXT NOT NULL,
      refund_index INTEGER NOT NULL,
      amount TEXT NOT NULL,
      status TEXT NOT NULL,
      tx_hash TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (order_id, refund_index)
    );
    CREATE TABLE IF NOT EXISTS pending_events (
      event_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      body TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );
  `);
}
