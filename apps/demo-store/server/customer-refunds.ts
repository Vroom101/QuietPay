import Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CustomerRefundStatus, type Refund } from "@quietpay/shared";
import { WebhookEvent } from "@quietpay/shared/webhook";
import { migrateCustomerRefunds } from "./customer-refund-migrations.js";

/** status rank: pending < settled < partially_refunded < refunded. Only ever raised. */
export const RANK = { pending: 0, settled: 1, partially_refunded: 2, refunded: 3 } as const;
const RANK_NAMES = ["pending", "settled", "partially_refunded", "refunded"] as const;
export function rankOfOrderStatus(status: string): number {
  if (status === "refunded") return RANK.refunded;
  if (status === "partially_refunded") return RANK.partially_refunded;
  if (status === "settled") return RANK.settled;
  return RANK.pending;
}
const ITEM_RANK: Record<string, number> = { pending: 0, failed: 1, settled: 2 };

export const REDACTED_HEADERS = ["req.headers.authorization", 'req.headers["quietpay-order-token"]'];

/** 32 random bytes, base64url. Shown once, never stored. */
export function newOrderToken(): string {
  return randomBytes(32).toString("base64url");
}
export const hashToken = (token: string): Buffer => createHash("sha256").update(token.slice(0, 512)).digest();
const DUMMY_DIGEST = hashToken(randomBytes(32).toString("base64url"));

/** Constant-time check of a presented token. For an unknown order it still hashes and compares against a dummy. */
export function tokenMatches(presented: unknown, storedHex: string | undefined): boolean {
  const digest = hashToken(typeof presented === "string" ? presented : "");
  const stored = storedHex ? Buffer.from(storedHex, "hex") : DUMMY_DIGEST;
  const equal = stored.length === digest.length && timingSafeEqual(stored, digest);
  return equal && storedHex !== undefined && typeof presented === "string";
}

/** Rate-limit key: IPv4 /32, IPv6 /64 (an IPv6 user controls a whole /64, so per-address limits are meaningless). */
export function ipKey(ip: string): string {
  let a = ip.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1]!;
  if (!a.includes(":")) return a;
  let [head, tail] = a.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `v6:${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}`;
}

/** Fixed-window counter with a cost per hit (failed attempts cost double) and a hard cap on tracked keys. */
export function createCostLimiter(limit: number, windowMs: number, now: () => number, maxKeys = 10_000) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const live = (key: string) => {
    const w = windows.get(key);
    return w && w.resetAt > now() ? w : undefined;
  };
  return {
    blocked: (key: string) => (live(key)?.count ?? 0) >= limit,
    add(key: string, cost: number) {
      let w = live(key);
      if (!w) {
        if (windows.size >= maxKeys) {
          for (const [k, v] of windows) if (v.resetAt <= now()) windows.delete(k);
          if (windows.size >= maxKeys) windows.delete(windows.keys().next().value as string);
        }
        w = { count: 0, resetAt: now() + windowMs };
        windows.set(key, w);
      }
      w.count += cost;
    },
  };
}

interface StateRow { order_id: string; amount_paid: string; total_refunded: string; status_rank: number; last_sync_at: number }
export type ApplyOutcome = "applied" | "deferred" | "rejected";

export class CustomerRefundStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    migrateCustomerRefunds(this.db);
  }
  close() { this.db.close(); }

  /** Called at checkout: stores sha256(token) only, plus the order amount at rank pending. */
  createOrder(orderId: string, tokenHash: Buffer, amount: string, nowSec: number) {
    const id = orderId.toLowerCase();
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO order_access (order_id, token_hash, created_at) VALUES (?,?,?)").run(id, tokenHash.toString("hex"), nowSec);
      this.db.prepare("INSERT OR IGNORE INTO order_refund_state (order_id, amount_paid, last_sync_at) VALUES (?,?,?)").run(id, amount, nowSec);
    })();
  }
  tokenHashHex(orderId: string): string | undefined {
    const r = this.db.prepare("SELECT token_hash FROM order_access WHERE order_id=?").get(orderId.toLowerCase()) as { token_hash: string } | undefined;
    return r?.token_hash;
  }
  hasOrder(orderId: string): boolean { return this.tokenHashHex(orderId) !== undefined; }
  private state(orderId: string): StateRow | undefined {
    return this.db.prepare("SELECT * FROM order_refund_state WHERE order_id=?").get(orderId.toLowerCase()) as StateRow | undefined;
  }
  syncAgeSec(orderId: string, nowSec: number): number | undefined {
    const s = this.state(orderId);
    return s && s.status_rank >= RANK.settled ? nowSec - s.last_sync_at : undefined;
  }

  /** The order is settled: raise the rank and apply any refund events that arrived early, in one transaction. */
  applySettled(orderId: string, amount: string, relayerStatusRank: number, nowSec: number): { applied: number; dropped: number } {
    const id = orderId.toLowerCase();
    return this.db.transaction(() => {
      const s = this.state(id);
      if (!s || s.amount_paid !== amount) return { applied: 0, dropped: 0 };
      this.db.prepare("UPDATE order_refund_state SET status_rank=MAX(status_rank,?), last_sync_at=MAX(last_sync_at,?) WHERE order_id=?")
        .run(Math.max(RANK.settled, relayerStatusRank), nowSec, id);
      let applied = 0, dropped = 0;
      const rows = this.db.prepare("SELECT event_id, body FROM pending_events WHERE order_id=? ORDER BY received_at, event_id").all(id) as { event_id: string; body: string }[];
      for (const row of rows) {
        let outcome: ApplyOutcome = "rejected";
        try { outcome = this.applyInTxn(WebhookEvent.parse(JSON.parse(row.body)), nowSec); } catch { /* corrupt row: drop */ }
        this.db.prepare("DELETE FROM pending_events WHERE event_id=?").run(row.event_id);
        if (outcome === "applied") applied++; else dropped++;
      }
      return { applied, dropped };
    })();
  }

  /** A confirmed payment.refunded event: applied now, or parked until the order settles. */
  applyRefundEvent(event: WebhookEvent, rawBody: string, nowSec: number): ApplyOutcome {
    return this.db.transaction(() => {
      const id = event.data.orderId.toLowerCase();
      const s = this.state(id);
      if (!s) return "rejected";
      if (!this.validEventAmounts(s, event)) return "rejected";
      if (s.status_rank < RANK.settled) {
        this.db.prepare("INSERT OR IGNORE INTO pending_events (event_id, order_id, body, received_at) VALUES (?,?,?,?)").run(event.id, id, rawBody, nowSec);
        return "deferred";
      }
      return this.applyInTxn(event, nowSec);
    })();
  }

  private validEventAmounts(s: StateRow, event: WebhookEvent): boolean {
    const d = event.data;
    if (d.amount !== s.amount_paid || d.refundAmount === undefined || d.totalRefunded === undefined || d.refundIndex === undefined) return false;
    const paid = BigInt(s.amount_paid);
    return BigInt(d.refundAmount) <= paid && BigInt(d.totalRefunded) <= paid;
  }

  private upsertItem(id: string, index: number, amount: string, status: string, txHash: string | undefined, createdAt: number) {
    const cur = this.db.prepare("SELECT status FROM customer_refunds WHERE order_id=? AND refund_index=?").get(id, index) as { status: string } | undefined;
    if (!cur) {
      this.db.prepare("INSERT INTO customer_refunds (order_id, refund_index, amount, status, tx_hash, created_at) VALUES (?,?,?,?,?,?)")
        .run(id, index, amount, status, txHash ?? null, createdAt);
      return;
    }
    if ((ITEM_RANK[status] ?? 0) > (ITEM_RANK[cur.status] ?? 0)) {
      this.db.prepare("UPDATE customer_refunds SET status=?, tx_hash=COALESCE(?, tx_hash) WHERE order_id=? AND refund_index=?").run(status, txHash ?? null, id, index);
    } else if (txHash) {
      this.db.prepare("UPDATE customer_refunds SET tx_hash=COALESCE(tx_hash, ?) WHERE order_id=? AND refund_index=?").run(txHash, id, index);
    }
  }

  /** Raise total and rank monotonically; throws if the total would exceed what was paid. */
  private raise(s: StateRow, total: bigint, nowSec: number) {
    const paid = BigInt(s.amount_paid);
    if (total > paid) throw new Error("total refunded exceeds amount paid");
    const best = total > BigInt(s.total_refunded) ? total : BigInt(s.total_refunded);
    const derived = best === 0n ? RANK.settled : best >= paid ? RANK.refunded : RANK.partially_refunded;
    this.db.prepare("UPDATE order_refund_state SET total_refunded=?, status_rank=MAX(status_rank,?), last_sync_at=MAX(last_sync_at,?) WHERE order_id=?")
      .run(best.toString(), derived, nowSec, s.order_id);
  }

  private applyInTxn(event: WebhookEvent, nowSec: number): ApplyOutcome {
    const id = event.data.orderId.toLowerCase();
    const s = this.state(id);
    if (!s || !this.validEventAmounts(s, event)) return "rejected";
    this.upsertItem(id, event.data.refundIndex!, event.data.refundAmount!, "settled", event.data.txHash, event.createdAt);
    this.raise(s, BigInt(event.data.totalRefunded!), nowSec);
    return "applied";
  }

  /** Merge the relayer's refund list with the same monotonic rules. All or nothing. */
  mergeRefunds(orderId: string, refunds: Refund[], nowSec: number): boolean {
    const id = orderId.toLowerCase();
    try {
      this.db.transaction(() => {
        const s = this.state(id);
        if (!s) throw new Error("unknown order");
        let settledSum = 0n;
        for (const r of refunds) {
          if (r.orderId.toLowerCase() !== id) throw new Error("refund belongs to another order");
          if (BigInt(r.amount) > BigInt(s.amount_paid)) throw new Error("refund larger than amount paid");
          this.upsertItem(id, r.refundIndex, r.amount, r.status, r.txHash, r.createdAt);
          if (r.status === "settled") settledSum += BigInt(r.amount);
        }
        this.raise(s, settledSum, nowSec);
      })();
      return true;
    } catch {
      return false;
    }
  }

  /** The only way data leaves the store for customers: a NEW object built field by field from an allowlist. */
  view(orderId: string): CustomerRefundStatus | undefined {
    const id = orderId.toLowerCase();
    const s = this.state(id);
    if (!s) return undefined;
    const rows = this.db.prepare("SELECT amount, status, tx_hash, created_at FROM customer_refunds WHERE order_id=? ORDER BY refund_index")
      .all(id) as { amount: string; status: string; tx_hash: string | null; created_at: number }[];
    const paid = BigInt(s.amount_paid);
    const total = BigInt(s.total_refunded);
    const out = {
      orderId: id,
      status: RANK_NAMES[s.status_rank] ?? "pending",
      amountPaid: s.amount_paid,
      totalRefunded: total.toString(),
      remaining: (paid - total).toString(),
      currency: "USDT" as const,
      lastUpdatedAt: s.last_sync_at,
      refunds: rows.map((r) => ({
        amount: r.amount,
        status: r.status,
        ...(r.tx_hash ? { txHash: r.tx_hash } : {}),
        createdAt: r.created_at,
      })),
    };
    return CustomerRefundStatus.parse(out);
  }
}
