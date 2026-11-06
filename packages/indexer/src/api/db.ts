import Database from "better-sqlite3";
import {
  normalizeScope,
  type Scope,
  type Block,
  type RecordedEvent,
  eventKey,
} from "./model.js";

export class IndexDb {
  readonly raw: Database.Database;
  readonly scope: Scope;
  constructor(path: string | Buffer, scope: Scope) {
    this.scope = normalizeScope(scope);
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw
      .exec(`CREATE TABLE IF NOT EXISTS index_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS index_blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS index_events (id TEXT PRIMARY KEY, block_number INTEGER NOT NULL, log_index INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_events_block ON index_events(block_number,log_index);`);
    // Confirmation depth may increase; sync rolls the stored cursor back to the new safe head.
    const { confirmations: _depth, ...identity } = this.scope;
    const binding = JSON.stringify(identity);
    const stored = this.raw
      .prepare("SELECT value FROM index_settings WHERE key='scope'")
      .get() as { value: string } | undefined;
    if (stored && stored.value !== binding) {
      this.raw.close();
      throw new Error(
        "Database belongs to a different chain/router/token/scope",
      );
    }
    this.raw
      .prepare("INSERT OR IGNORE INTO index_settings VALUES ('scope',?)")
      .run(binding);
  }
  get cursor(): number {
    const row = this.raw
      .prepare("SELECT value FROM index_settings WHERE key='cursor'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : this.scope.deploymentBlock - 1;
  }
  block(number: number): Block | undefined {
    return this.raw
      .prepare("SELECT number,hash,timestamp FROM index_blocks WHERE number=?")
      .get(number) as Block | undefined;
  }
  checkpoints(): Block[] {
    return this.raw
      .prepare(
        "SELECT number,hash,timestamp FROM index_blocks ORDER BY number DESC",
      )
      .all() as Block[];
  }
  events(to = this.cursor): RecordedEvent[] {
    return (
      this.raw
        .prepare(
          "SELECT body FROM index_events WHERE block_number<=? ORDER BY block_number,log_index,id",
        )
        .all(to) as { body: string }[]
    ).map((row) => JSON.parse(row.body) as RecordedEvent);
  }
  private setCursor(number: number) {
    this.raw
      .prepare(
        "INSERT INTO index_settings VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(number));
  }
  commit(to: number, page: { blocks: Block[]; events: RecordedEvent[] }) {
    this.raw.transaction(() => {
      const block = this.raw.prepare(
        "INSERT OR REPLACE INTO index_blocks VALUES (@number,@hash,@timestamp)",
      );
      for (const b of page.blocks) block.run(b);
      const insert = this.raw.prepare(
        "INSERT INTO index_events VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING",
      );
      for (const e of page.events) {
        const id = eventKey(e.event),
          body = JSON.stringify(e);
        const existing = this.raw
          .prepare("SELECT body FROM index_events WHERE id=?")
          .get(id) as { body: string } | undefined;
        if (existing && existing.body !== body)
          throw new Error(`Conflicting stored log ${id}`);
        insert.run(id, e.event.blockNumber, e.event.logIndex, body);
      }
      this.setCursor(to);
    })();
  }
  rollback(to: number) {
    this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM index_events WHERE block_number>?").run(to);
      this.raw.prepare("DELETE FROM index_blocks WHERE number>?").run(to);
      this.setCursor(to);
    })();
  }
  close() {
    this.raw.close();
  }
}
