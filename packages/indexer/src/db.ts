import Database from "better-sqlite3";
import type { LedgerRow, RawEvent, RawKind } from "./types.js";

export class IndexerDb {
  readonly raw: Database.Database;

  constructor(path: string) {
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS raw_events (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        block INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        address TEXT NOT NULL,
        kind TEXT NOT NULL,
        args TEXT NOT NULL,
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS idx_raw_block ON raw_events(block, log_index);
      CREATE TABLE IF NOT EXISTS ledger (
        key TEXT PRIMARY KEY,
        date_utc TEXT NOT NULL,
        source TEXT NOT NULL,
        order_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        payer TEXT NOT NULL,
        gross_usdt TEXT NOT NULL,
        relay_fee_usdt TEXT NOT NULL,
        refunded_usdt TEXT NOT NULL,
        net_usdt TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        block INTEGER NOT NULL,
        log_index INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  close() {
    this.raw.close();
  }

  // ---- cursor: last FINALIZED block scanned
  getCursor(): { block: number; hash: string } | undefined {
    const b = this.raw.prepare("SELECT value FROM state WHERE key='cursor_block'").get() as { value: string } | undefined;
    const h = this.raw.prepare("SELECT value FROM state WHERE key='cursor_hash'").get() as { value: string } | undefined;
    return b && h ? { block: Number(b.value), hash: h.value } : undefined;
  }

  setCursor(block: number, hash: string) {
    const up = this.raw.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    up.run("cursor_block", String(block));
    up.run("cursor_hash", hash);
  }

  // ---- raw events (idempotent on (tx_hash, log_index))
  insertEvents(events: RawEvent[]): number {
    const stmt = this.raw.prepare(
      `INSERT OR IGNORE INTO raw_events (tx_hash, log_index, block, block_hash, timestamp, address, kind, args)
       VALUES (@txHash, @logIndex, @block, @blockHash, @timestamp, @address, @kind, @args)`,
    );
    let n = 0;
    for (const e of events) n += stmt.run({ ...e, args: JSON.stringify(e.args) }).changes;
    return n;
  }

  /** Raw events with block <= toBlock (optionally >= fromBlock), ordered by block then log index. */
  events(opts: { fromBlock?: number; toBlock?: number } = {}): RawEvent[] {
    const rows = this.raw
      .prepare("SELECT * FROM raw_events WHERE block >= ? AND block <= ? ORDER BY block, log_index")
      .all(opts.fromBlock ?? 0, opts.toBlock ?? Number.MAX_SAFE_INTEGER) as {
      tx_hash: string;
      log_index: number;
      block: number;
      block_hash: string;
      timestamp: number;
      address: string;
      kind: string;
      args: string;
    }[];
    return rows.map((r) => ({
      txHash: r.tx_hash,
      logIndex: r.log_index,
      block: r.block,
      blockHash: r.block_hash,
      timestamp: r.timestamp,
      address: r.address,
      kind: r.kind as RawKind,
      args: JSON.parse(r.args) as Record<string, string>,
    }));
  }

  // ---- ledger (derived; safe to wipe and rebuild)
  upsertLedger(rows: LedgerRow[]) {
    const stmt = this.raw.prepare(
      `INSERT INTO ledger (key, date_utc, source, order_id, merchant_id, payer, gross_usdt, relay_fee_usdt, refunded_usdt, net_usdt, status, tx_hash, block, log_index)
       VALUES (@key, @dateUtc, @source, @orderId, @merchantId, @payer, @grossUsdt, @relayFeeUsdt, @refundedUsdt, @netUsdt, @status, @txHash, @block, @logIndex)
       ON CONFLICT(key) DO UPDATE SET date_utc=excluded.date_utc, source=excluded.source, order_id=excluded.order_id,
         merchant_id=excluded.merchant_id, payer=excluded.payer, gross_usdt=excluded.gross_usdt,
         relay_fee_usdt=excluded.relay_fee_usdt, refunded_usdt=excluded.refunded_usdt, net_usdt=excluded.net_usdt,
         status=excluded.status, tx_hash=excluded.tx_hash, block=excluded.block, log_index=excluded.log_index`,
    );
    for (const r of rows) stmt.run(r);
  }

  clearLedger() {
    this.raw.prepare("DELETE FROM ledger").run();
  }

  ledger(): LedgerRow[] {
    const rows = this.raw.prepare("SELECT * FROM ledger ORDER BY block, log_index").all() as Record<string, unknown>[];
    return rows.map((r) => ({
      key: r.key as string,
      dateUtc: r.date_utc as string,
      source: r.source as LedgerRow["source"],
      orderId: r.order_id as string,
      merchantId: r.merchant_id as string,
      payer: r.payer as string,
      grossUsdt: r.gross_usdt as string,
      relayFeeUsdt: r.relay_fee_usdt as string,
      refundedUsdt: r.refunded_usdt as string,
      netUsdt: r.net_usdt as string,
      status: r.status as LedgerRow["status"],
      txHash: r.tx_hash as string,
      block: r.block as number,
      logIndex: r.log_index as number,
    }));
  }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }
}
