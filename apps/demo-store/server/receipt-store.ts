import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PaidRecord } from "./app.js";

/** Verified webhook records and deduplication commit together. */
export class ReceiptStore {
  private readonly db: Database.Database;
  constructor(path: string, scope: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS receipt_scope (scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipt_events (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS paid_receipts (order_id TEXT PRIMARY KEY, record TEXT NOT NULL);`);
    try {
      this.db.transaction(() => {
        const row = this.db.prepare("SELECT scope FROM receipt_scope").get() as { scope: string } | undefined;
        if (row && row.scope !== scope) throw new Error("Receipt database belongs to a different merchant or relayer");
        if (!row) this.db.prepare("INSERT INTO receipt_scope VALUES (?)").run(scope);
      })();
    } catch (error) { this.db.close(); throw error; }
  }
  record(id: string, receipt?: PaidRecord): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare("INSERT OR IGNORE INTO receipt_events VALUES (?)").run(id);
      if (!result.changes) return false;
      if (receipt) this.db.prepare("INSERT OR IGNORE INTO paid_receipts VALUES (?,?)")
        .run(receipt.orderId.toLowerCase(), JSON.stringify(receipt));
      return true;
    })();
  }
  get(id: string): PaidRecord | undefined {
    const row = this.db.prepare("SELECT record FROM paid_receipts WHERE order_id=?").get(id.toLowerCase()) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as PaidRecord : undefined;
  }
  close() { this.db.close(); }
}
