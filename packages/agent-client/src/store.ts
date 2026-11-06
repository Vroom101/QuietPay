/**
 * Crash-safe persistent state for the x402 agent client (opt-in: `store: { path, ... }`).
 *
 * Security notes (see docs/b/build/agent-store.md):
 *  - The store holds payment terms and signed authorizations (a signature is a BEARER instrument:
 *    anyone who reads it can submit it before validBefore). It never holds the private key, mnemonic
 *    or RPC URLs. The directory is created 0700 and files are 0600 (umask set before opening so the
 *    -wal/-shm siblings match). On Windows chmod is largely a no-op: rely on the user profile ACLs.
 *  - Every state change is an append-only event whose MAC chains to the previous one (HMAC-SHA256
 *    keyed from a secret the caller supplies and which is never stored). Opening a store whose
 *    events or projection were edited or had events deleted throws StoreIntegrityError. A whole-file
 *    rollback to an older consistent copy cannot be detected from the file alone; reconcile against
 *    AuthorizationUsed events (recovery.reconcile) and keep no more than the budget in the wallet.
 */
import Database from "better-sqlite3";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

export type PaymentState =
  | "intent"
  | "signed"
  | "submitted"
  | "settled"
  | "failed";

export interface ReceiptEvidence {
  success: boolean;
  logs: { address: Address; topics: Hex[]; data: Hex }[];
}
/** Read-only chain facts. Implementations must use the `finalized` tag for the finalized* methods. */
export interface ChainEvidence {
  /** Timestamp of the latest block (chain time, never the local clock). */
  latestTimestamp(): Promise<bigint>;
  /** Timestamp of the latest FINALIZED block. */
  finalizedTimestamp(): Promise<bigint>;
  /** authorizationState(payer, nonce) read at the finalized tag. */
  authorizationUsedAtFinalized(
    token: Address,
    payer: Address,
    nonce: Hex,
  ): Promise<boolean>;
  /** Transaction that emitted AuthorizationUsed(payer, nonce) on token, if any is visible. */
  findAuthorizationUsedTx(
    token: Address,
    payer: Address,
    nonce: Hex,
  ): Promise<Hex | null>;
  getReceipt(tx: Hex): Promise<ReceiptEvidence | null>;
  /** Optional: every nonce the payer has used on token (for reconcile). */
  listUsedNonces?(token: Address, payer: Address): Promise<Hex[]>;
}
export type FacilitatorStatus = "settled" | "pending" | "failed" | "unknown";
/** GET /v1/x402/payments/:payer/:nonce. Advisory only. */
export interface FacilitatorLookup {
  status(args: {
    payer: Address;
    nonce: Hex;
  }): Promise<{ status: FacilitatorStatus; transaction?: Hex }>;
}
export interface StoreConfig {
  path: string;
  /** Secret the MAC key is derived from. Supplied by the caller, never stored. */
  secret: string | Uint8Array;
  chain: ChainEvidence;
  facilitator?: FacilitatorLookup;
  /** Cap on maxTimeoutSeconds from a challenge (default 300). */
  maxTimeoutCapSeconds?: number;
  /** Re-sign an unsigned intent only if validBefore - chainNow exceeds this (default 30). */
  expiryMarginSeconds?: number;
  busyTimeoutMs?: number;
  leaseTtlMs?: number;
  /** Test hook: called at named points; throw to simulate a crash. */
  faultInjection?: (point: string) => void;
  /** Test only: skip the per-session lease (to prove the BEGIN IMMEDIATE budget check alone). */
  unsafeNoLease?: boolean;
}
export interface SessionTerms {
  chainId: number;
  token: Address;
  payer: Address;
  budget: bigint;
  domainName: string;
  domainVersion: string;
}
export interface PaymentRecord {
  nonce: Hex;
  counter: number;
  state: PaymentState;
  resource: string;
  /** JSON of { resource, accepted } from the challenge: needed to rebuild the payload on re-sign. */
  accepted: string;
  payTo: Address;
  amount: string;
  validAfter: string;
  validBefore: string;
  signature: Hex | null;
  payload: string | null;
  transaction: Hex | null;
  released: boolean;
  delivered: boolean;
  abandoned: boolean;
  note: string | null;
}

export class StoreError extends Error {
  constructor(
    public readonly code:
      | "integrity"
      | "mismatch"
      | "lease"
      | "budget"
      | "pending"
      | "path"
      | "transition"
      | "terms",
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}
export const StoreIntegrityError = (m: string) => new StoreError("integrity", m);

const NONCE_TAG = keccak256(stringToHex("quietpay.agent-client.nonce.v1"));
export function deriveNonce(a: {
  chainId: number;
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  resource: string;
  sessionId: Hex;
  counter: number;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [
        NONCE_TAG,
        BigInt(a.chainId),
        a.token,
        a.from,
        a.to,
        a.value,
        a.validAfter,
        a.validBefore,
        keccak256(stringToHex(a.resource)),
        a.sessionId,
        BigInt(a.counter),
      ],
    ),
  );
}
export function idempotencyKey(a: {
  chainId: number;
  token: Address;
  payer: Address;
  nonce: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
      ],
      [BigInt(a.chainId), a.token, a.payer, a.nonce],
    ),
  );
}

const FIELDS = [
  "nonce",
  "counter",
  "state",
  "resource",
  "accepted",
  "payTo",
  "amount",
  "validAfter",
  "validBefore",
  "signature",
  "payload",
  "transaction",
  "released",
  "delivered",
  "abandoned",
  "note",
] as const;
const canon = (r: PaymentRecord) =>
  JSON.stringify(FIELDS.map((f) => (r as unknown as Record<string, unknown>)[f]));
const NEXT: Record<PaymentState, PaymentState[]> = {
  intent: ["signed", "failed"],
  signed: ["submitted", "settled", "failed"],
  submitted: ["submitted", "settled", "failed"],
  failed: ["settled", "submitted"],
  settled: ["settled"],
};

export function assertSafeStorePath(path: string): string {
  if (typeof path !== "string" || !path || path.includes("\0"))
    throw new StoreError("path", "Store path must be a non-empty string");
  if (path === ":memory:" || /^file:/i.test(path))
    throw new StoreError("path", "Store path must be a real file path");
  if (path.split(/[\\/]+/).includes(".."))
    throw new StoreError("path", "Store path must not contain '..' segments");
  const abs = resolve(path);
  const refuse = (p: string, what: string) => {
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new StoreError("path", `Store ${what} must not be a symlink`);
  };
  refuse(abs, "file");
  refuse(dirname(abs), "directory");
  if (existsSync(abs) && !lstatSync(abs).isFile())
    throw new StoreError("path", "Store path must be a regular file");
  return abs;
}

function hmac(key: Buffer, ...parts: string[]): string {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p).update("\u0000");
  return h.digest("hex");
}
const safeEq = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  nonce TEXT PRIMARY KEY,
  counter INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intent','signed','submitted','settled','failed')),
  resource TEXT NOT NULL,
  accepted TEXT NOT NULL,
  payTo TEXT NOT NULL,
  amount TEXT NOT NULL,
  validAfter TEXT NOT NULL,
  validBefore TEXT NOT NULL,
  signature TEXT, payload TEXT, "transaction" TEXT,
  released INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0,
  abandoned INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  UNIQUE (counter)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_per_resource ON payments (resource)
  WHERE state IN ('intent','signed','submitted') AND released = 0;
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, nonce TEXT, snapshot TEXT NOT NULL, mac TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
`;

type Row = Record<string, unknown>;
const toRecord = (r: Row): PaymentRecord => ({
  nonce: r.nonce as Hex,
  counter: Number(r.counter),
  state: r.state as PaymentState,
  resource: r.resource as string,
  accepted: r.accepted as string,
  payTo: r.payTo as Address,
  amount: r.amount as string,
  validAfter: r.validAfter as string,
  validBefore: r.validBefore as string,
  signature: (r.signature as Hex | null) ?? null,
  payload: (r.payload as string | null) ?? null,
  transaction: (r.transaction as Hex | null) ?? null,
  released: Boolean(r.released),
  delivered: Boolean(r.delivered),
  abandoned: Boolean(r.abandoned),
  note: (r.note as string | null) ?? null,
});

export class AgentStore {
  readonly sessionId: Hex;
  readonly terms: SessionTerms;
  readonly owner = randomBytes(16).toString("hex");
  private closed = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private constructor(
    private readonly db: Database.Database,
    private readonly key: Buffer,
    readonly config: StoreConfig,
    sessionId: Hex,
    terms: SessionTerms,
  ) {
    this.sessionId = sessionId;
    this.terms = terms;
  }

  static open(config: StoreConfig, expected: SessionTerms): AgentStore {
    const secret =
      typeof config.secret === "string"
        ? Buffer.from(config.secret, "utf8")
        : Buffer.from(config.secret);
    if (secret.length < 16)
      throw new StoreError("integrity", "Store secret must be at least 16 bytes");
    const abs = assertSafeStorePath(config.path);
    const dir = dirname(abs);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      tryChmod(dir, 0o700);
    }
    let old: number | undefined;
    try {
      old = process.umask(0o077);
    } catch {
      /* worker threads cannot set umask; chmod below still applies */
    }
    let db: Database.Database;
    try {
      db = new Database(abs);
    } finally {
      if (old !== undefined) process.umask(old);
    }
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.pragma(`busy_timeout = ${Math.max(0, config.busyTimeoutMs ?? 5000) | 0}`);
      db.exec(SCHEMA);
      for (const s of ["", "-wal", "-shm"]) tryChmod(abs + s, 0o600);
      const key = createHmac("sha256", secret)
        .update("quietpay-agent-store/v1/mac")
        .digest();
      const store = AgentStore.init(db, key, config, expected);
      for (const s of ["", "-wal", "-shm"]) tryChmod(abs + s, 0o600);
      return store;
    } catch (e) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  private static init(
    db: Database.Database,
    key: Buffer,
    config: StoreConfig,
    expected: SessionTerms,
  ): AgentStore {
    const termsJson = (t: SessionTerms, sessionId: string) =>
      JSON.stringify([
        sessionId,
        t.chainId,
        getAddress(t.token),
        getAddress(t.payer),
        t.budget.toString(),
        t.domainName,
        t.domainVersion,
      ]);
    const metaRow = db.prepare("SELECT v FROM meta WHERE k='session'").get() as
      | { v: string }
      | undefined;
    const evCount = (
      db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }
    ).c;
    let sessionId: Hex;
    if (!metaRow && evCount === 0) {
      sessionId = `0x${randomBytes(32).toString("hex")}`;
      const snap = termsJson(expected, sessionId);
      db.transaction(() => {
        db.prepare("INSERT INTO meta (k,v) VALUES ('session',?)").run(snap);
        db.prepare(
          "INSERT INTO events (seq,kind,nonce,snapshot,mac) VALUES (1,'session',NULL,?,?)",
        ).run(snap, hmac(key, "", "1", "session", "", snap));
      }).immediate();
    } else if (!metaRow || evCount === 0) {
      throw StoreIntegrityError("Session record or event log is missing");
    }
    const verified = AgentStore.verifyDb(db, key);
    sessionId = verified.sessionId;
    // Terms must be exactly those this session was created with.
    if (termsJson(expected, sessionId) !== verified.sessionSnapshot)
      throw new StoreError(
        "mismatch",
        "Store was created with different session terms (chain, token, payer, budget or domain)",
      );
    const store = new AgentStore(db, key, config, sessionId, expected);
    if (!config.unsafeNoLease) store.acquireLease();
    return store;
  }

  /** Replays the event log and compares it with the projection. Throws StoreError("integrity"). */
  private static verifyDb(
    db: Database.Database,
    key: Buffer,
  ): { sessionId: Hex; sessionSnapshot: string } {
    const events = db
      .prepare("SELECT seq,kind,nonce,snapshot,mac FROM events ORDER BY seq")
      .all() as { seq: number; kind: string; nonce: string | null; snapshot: string; mac: string }[];
    let prev = "";
    const last = new Map<string, string>();
    let sessionSnapshot = "";
    events.forEach((e, i) => {
      if (e.seq !== i + 1) throw StoreIntegrityError("Event log has a gap or reorder");
      const expect = hmac(key, prev, String(e.seq), e.kind, e.nonce ?? "", e.snapshot);
      if (!safeEq(expect, e.mac))
        throw StoreIntegrityError(`Event ${e.seq} failed its integrity check`);
      prev = e.mac;
      if (e.kind === "session") {
        if (i !== 0) throw StoreIntegrityError("Unexpected session event");
        sessionSnapshot = e.snapshot;
      } else if (e.nonce) last.set(e.nonce, e.snapshot);
      else throw StoreIntegrityError("Event without a nonce");
    });
    if (!sessionSnapshot) throw StoreIntegrityError("Missing session event");
    const meta = db.prepare("SELECT v FROM meta WHERE k='session'").get() as { v: string } | undefined;
    if (!meta || meta.v !== sessionSnapshot)
      throw StoreIntegrityError("Session record was modified");
    const rows = db.prepare("SELECT * FROM payments").all() as Row[];
    if (rows.length !== last.size)
      throw StoreIntegrityError("Payment rows were added or deleted");
    for (const r of rows) {
      const snap = last.get(r.nonce as string);
      let rec: PaymentRecord;
      try {
        rec = toRecord(r);
      } catch {
        throw StoreIntegrityError("Unreadable payment row");
      }
      if (snap === undefined || canon(rec) !== snap)
        throw StoreIntegrityError(`Payment ${String(r.nonce)} was modified`);
    }
    const parsed = JSON.parse(sessionSnapshot) as [Hex];
    return { sessionId: parsed[0], sessionSnapshot };
  }

  /** Re-verify the whole file (also run before every recovery). */
  verify(): void {
    AgentStore.verifyDb(this.db, this.key);
  }

  private acquireLease() {
    const ttl = this.config.leaseTtlMs ?? 15000;
    this.db
      .transaction(() => {
        const now = Date.now();
        const cur = this.db.prepare("SELECT owner,expires_at FROM lease WHERE id=1").get() as
          | { owner: string; expires_at: number }
          | undefined;
        if (cur && cur.owner !== this.owner && cur.expires_at > now)
          throw new StoreError("lease", "Another process is driving this session");
        this.db
          .prepare(
            "INSERT INTO lease (id,owner,expires_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at",
          )
          .run(this.owner, now + ttl);
      })
      .immediate();
    this.heartbeat = setInterval(() => {
      try {
        this.db
          .prepare("UPDATE lease SET expires_at=? WHERE id=1 AND owner=?")
          .run(Date.now() + ttl, this.owner);
      } catch {
        /* closed */
      }
    }, Math.max(250, Math.floor(ttl / 3)));
    this.heartbeat.unref?.();
  }
  private assertLease() {
    if (this.closed) throw new StoreError("lease", "Store is closed");
    if (this.config.unsafeNoLease) return;
    const cur = this.db.prepare("SELECT owner,expires_at FROM lease WHERE id=1").get() as
      | { owner: string; expires_at: number }
      | undefined;
    if (!cur || cur.owner !== this.owner)
      throw new StoreError("lease", "Session lease was lost to another process");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    try {
      if (!this.config.unsafeNoLease)
        this.db.prepare("DELETE FROM lease WHERE id=1 AND owner=?").run(this.owner);
    } catch {
      /* ignore */
    }
    this.db.close();
  }

  private fault(point: string) {
    this.config.faultInjection?.(point);
  }

  private lastMac(): { seq: number; mac: string } {
    const r = this.db.prepare("SELECT seq,mac FROM events ORDER BY seq DESC LIMIT 1").get() as {
      seq: number;
      mac: string;
    };
    return r;
  }
  private writeEvent(kind: string, rec: PaymentRecord) {
    const { seq, mac } = this.lastMac();
    const snap = canon(rec);
    this.db
      .prepare("INSERT INTO events (seq,kind,nonce,snapshot,mac) VALUES (?,?,?,?,?)")
      .run(seq + 1, kind, rec.nonce, snap, hmac(this.key, mac, String(seq + 1), kind, rec.nonce, snap));
  }
  private upsert(rec: PaymentRecord) {
    this.db
      .prepare(
        `INSERT INTO payments (nonce,counter,state,resource,accepted,payTo,amount,validAfter,validBefore,signature,payload,"transaction",released,delivered,abandoned,note)
         VALUES (@nonce,@counter,@state,@resource,@accepted,@payTo,@amount,@validAfter,@validBefore,@signature,@payload,@transaction,@released,@delivered,@abandoned,@note)
         ON CONFLICT(nonce) DO UPDATE SET state=excluded.state, signature=excluded.signature, payload=excluded.payload,
           "transaction"=excluded."transaction", released=excluded.released, delivered=excluded.delivered,
           abandoned=excluded.abandoned, note=excluded.note`,
      )
      .run({
        ...rec,
        released: rec.released ? 1 : 0,
        delivered: rec.delivered ? 1 : 0,
        abandoned: rec.abandoned ? 1 : 0,
      });
  }

  // ---- reads ----
  list(): PaymentRecord[] {
    return (this.db.prepare("SELECT * FROM payments ORDER BY counter").all() as Row[]).map(toRecord);
  }
  get(nonce: Hex): PaymentRecord | undefined {
    const r = this.db.prepare("SELECT * FROM payments WHERE nonce=?").get(nonce) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }
  /** Sum of every non-released row. */
  reserved(): bigint {
    return this.list()
      .filter((r) => !r.released)
      .reduce((s, r) => s + BigInt(r.amount), 0n);
  }
  /** A row still holding budget for a resource that has not been delivered. */
  openForResource(resource: string): PaymentRecord | undefined {
    return this.list().find((r) => r.resource === resource && !r.released && !r.delivered);
  }
  /** Rows that need recovery work. */
  unresolved(): PaymentRecord[] {
    return this.list().filter(
      (r) => !r.released && r.state !== "settled",
    );
  }

  // ---- writes (each is one transaction) ----
  /** Reserve budget and persist the intent atomically. Nonce is derived from ALL terms. */
  reserveIntent(t: {
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    resource: string;
    accepted: string;
  }): PaymentRecord {
    this.assertLease();
    this.fault("before:intent");
    const to = getAddress(t.to);
    const rec = this.db
      .transaction((): PaymentRecord => {
        const all = this.list();
        const used = all.filter((r) => !r.released).reduce((s, r) => s + BigInt(r.amount), 0n);
        if (t.value <= 0n || used + t.value > this.terms.budget)
          throw new StoreError("budget", "Session budget would be exceeded");
        if (
          all.some(
            (r) =>
              r.resource === t.resource &&
              !r.released &&
              ["intent", "signed", "submitted"].includes(r.state),
          )
        )
          throw new StoreError("pending", "A payment for this resource is already in progress");
        const counter = all.reduce((m, r) => Math.max(m, r.counter), 0) + 1;
        const nonce = deriveNonce({
          chainId: this.terms.chainId,
          token: this.terms.token,
          from: this.terms.payer,
          to,
          value: t.value,
          validAfter: t.validAfter,
          validBefore: t.validBefore,
          resource: t.resource,
          sessionId: this.sessionId,
          counter,
        });
        const r: PaymentRecord = {
          nonce,
          counter,
          state: "intent",
          resource: t.resource,
          accepted: t.accepted,
          payTo: to,
          amount: t.value.toString(),
          validAfter: t.validAfter.toString(),
          validBefore: t.validBefore.toString(),
          signature: null,
          payload: null,
          transaction: null,
          released: false,
          delivered: false,
          abandoned: false,
          note: null,
        };
        this.upsert(r);
        this.writeEvent("intent", r);
        return r;
      })
      .immediate();
    this.fault("after:intent");
    return rec;
  }

  private mutate(
    kind: string,
    nonce: Hex,
    fn: (r: PaymentRecord) => PaymentRecord,
  ): PaymentRecord {
    this.assertLease();
    this.fault(`before:${kind}`);
    const out = this.db
      .transaction((): PaymentRecord => {
        const cur = this.get(nonce);
        if (!cur) throw new StoreError("transition", "Unknown payment");
        const next = fn({ ...cur });
        // Terms are immutable.
        for (const f of ["nonce", "counter", "resource", "accepted", "payTo", "amount", "validAfter", "validBefore"] as const)
          if (next[f] !== cur[f]) throw new StoreError("terms", `Payment term ${f} cannot change`);
        if (next.state !== cur.state && !NEXT[cur.state].includes(next.state))
          throw new StoreError("transition", `Illegal transition ${cur.state} -> ${next.state}`);
        if (cur.signature && next.signature !== cur.signature)
          throw new StoreError("terms", "A signed authorization cannot be replaced");
        this.upsert(next);
        this.writeEvent(kind, next);
        return next;
      })
      .immediate();
    this.fault(`after:${kind}`);
    return out;
  }

  markSigned(nonce: Hex, signature: Hex, payload: string): PaymentRecord {
    return this.mutate("signed", nonce, (r) => {
      if (r.state !== "intent") throw new StoreError("transition", "Only an intent can be signed");
      const p = JSON.parse(payload) as {
        payload?: { authorization?: Record<string, string> };
      };
      const a = p.payload?.authorization;
      if (
        !a ||
        a.nonce?.toLowerCase() !== r.nonce.toLowerCase() ||
        a.value !== r.amount ||
        a.to?.toLowerCase() !== r.payTo.toLowerCase() ||
        a.validBefore !== r.validBefore ||
        a.validAfter !== r.validAfter ||
        a.from?.toLowerCase() !== this.terms.payer.toLowerCase()
      )
        throw new StoreError("terms", "Authorization does not match the stored terms");
      return { ...r, state: "signed", signature, payload, abandoned: false };
    });
  }
  markSubmitted(nonce: Hex): PaymentRecord {
    return this.mutate("submitted", nonce, (r) => {
      if (r.state === "settled") return r;
      if (!r.payload) throw new StoreError("transition", "Nothing signed to submit");
      return { ...r, state: "submitted" };
    });
  }
  noteTransaction(nonce: Hex, tx: Hex): PaymentRecord {
    return this.mutate("tx", nonce, (r) => {
      if (r.transaction && r.transaction !== tx) return r;
      return { ...r, transaction: tx };
    });
  }
  markSettled(nonce: Hex, tx: Hex, delivered: boolean): PaymentRecord {
    return this.mutate("settled", nonce, (r) => ({
      ...r,
      state: "settled",
      transaction: tx,
      delivered: r.delivered || delivered,
      note: null,
    }));
  }
  markDelivered(nonce: Hex): PaymentRecord {
    return this.mutate("delivered", nonce, (r) => ({ ...r, delivered: true }));
  }
  markFailed(nonce: Hex, note?: string): PaymentRecord {
    return this.mutate("failed", nonce, (r) =>
      r.state === "settled" ? r : { ...r, state: "failed", note: note ?? r.note },
    );
  }
  markAbandoned(nonce: Hex): PaymentRecord {
    return this.mutate("abandoned", nonce, (r) => ({ ...r, abandoned: true }));
  }
  setNote(nonce: Hex, note: string): PaymentRecord {
    return this.mutate("note", nonce, (r) => ({ ...r, note }));
  }
  /** Release budget. Only legal when a FINALIZED block timestamp is past validBefore. */
  release(nonce: Hex, finalizedTimestamp: bigint): PaymentRecord {
    return this.mutate("released", nonce, (r) => {
      if (r.state === "settled")
        throw new StoreError("transition", "A settled payment never releases budget");
      if (finalizedTimestamp <= BigInt(r.validBefore))
        throw new StoreError("transition", "Authorization has not expired on finalized chain time");
      return { ...r, released: true, state: r.state === "intent" ? "intent" : "failed" };
    });
  }
}

function tryChmod(p: string, mode: number) {
  try {
    if (existsSync(p)) chmodSync(p, mode);
  } catch {
    /* best effort; weak on Windows */
  }
}
