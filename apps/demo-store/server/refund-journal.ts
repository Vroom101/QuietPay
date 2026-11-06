import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MerchantRefundOperation, type Refund } from "@quietpay/shared";

interface Row {
  request_id: string;
  order_id: string;
  amount: string;
  refund_index: number;
  status: string;
  known_ids: string;
  refund: string | null;
  failure_code: string | null;
  created_at: number;
}
/** Persistent business request identity. Never stores private keys or signed payloads. */
export class RefundJournal {
  readonly db: Database.Database;
  constructor(path: string, scope: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS merchant_scope (scope TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS refund_requests (
        request_id TEXT PRIMARY KEY, order_id TEXT NOT NULL, amount TEXT NOT NULL,
        refund_index INTEGER NOT NULL, status TEXT NOT NULL, known_ids TEXT NOT NULL,
        refund TEXT, failure_code TEXT, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_refund ON refund_requests(order_id)
        WHERE status IN ('submitting','unknown','pending');`);
    try {
      this.db.transaction(() => {
        const row = this.db
          .prepare("SELECT scope FROM merchant_scope")
          .get() as { scope: string } | undefined;
        if (row && row.scope !== scope)
          throw new Error(
            "Refund database belongs to a different merchant, signer or deployment",
          );
        if (!row)
          this.db.prepare("INSERT INTO merchant_scope VALUES (?)").run(scope);
      })();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get(id: string) {
    return this.db
      .prepare("SELECT * FROM refund_requests WHERE request_id=?")
      .get(id) as Row | undefined;
  }
  list(order: string) {
    return this.db
      .prepare(
        "SELECT * FROM refund_requests WHERE order_id=? ORDER BY created_at DESC, rowid DESC",
      )
      .all(order) as Row[];
  }
  claim(
    input: {
      requestId: string;
      orderId: string;
      amount: string;
      refundIndex: number;
    },
    knownIds: string[],
  ) {
    this.db
      .prepare(
        "INSERT INTO refund_requests VALUES (?,?,?,?, 'submitting',?,NULL,NULL,?)",
      )
      .run(
        input.requestId,
        input.orderId,
        input.amount,
        input.refundIndex,
        JSON.stringify(knownIds),
        Math.floor(Date.now() / 1000),
      );
    return this.get(input.requestId)!;
  }
  update(id: string, status: string, refund?: Refund, failureCode?: string) {
    this.db
      .prepare(
        "UPDATE refund_requests SET status=?,refund=COALESCE(?,refund),failure_code=? WHERE request_id=?",
      )
      .run(
        status,
        refund ? JSON.stringify(refund) : null,
        failureCode ?? null,
        id,
      );
    return this.get(id)!;
  }
  reconcile(row: Row, refunds: Refund[]) {
    const known = JSON.parse(row.known_ids) as string[];
    const previous = row.refund
      ? (JSON.parse(row.refund) as Refund)
      : undefined;
    const found = previous
      ? refunds.find((r) => r.id === previous.id)
      : refunds.find(
          (r) =>
            !known.includes(r.id) &&
            r.refundIndex === row.refund_index &&
            r.amount === row.amount,
        );
    return found
      ? this.update(row.request_id, found.status, found, found.failureCode)
      : row;
  }
  view(row: Row) {
    return MerchantRefundOperation.parse({
      requestId: row.request_id,
      orderId: row.order_id,
      amount: row.amount,
      refundIndex: row.refund_index,
      status: row.status,
      refund: row.refund ? JSON.parse(row.refund) : undefined,
      failureCode: row.failure_code ?? undefined,
      createdAt: row.created_at,
    });
  }
  close() {
    this.db.close();
  }
}
