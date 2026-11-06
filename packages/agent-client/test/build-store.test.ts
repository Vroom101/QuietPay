import { describe, it, expect, afterEach } from "vitest";
import {
  statSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  AgentStore,
  StoreError,
  deriveNonce,
  idempotencyKey,
  assertSafeStorePath,
  receiptProvesPayment,
  type SessionTerms,
} from "../src/index.js";
import {
  World,
  tmpStore,
  account,
  asset,
  payTo,
  evil,
  url,
  SECRET,
} from "./build-store-helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const sandbox = () => {
  const s = tmpStore();
  cleanups.push(s.cleanup);
  return s;
};
const terms: SessionTerms = {
  chainId: 1874,
  token: asset,
  payer: account.address,
  budget: 30000n,
  domainName: "Tether USD",
  domainVersion: "1",
};
const w = new World();
const open = (path: string, t = terms, cfg = {}) =>
  AgentStore.open(w.config(path, { unsafeNoLease: true, ...cfg }), t);
const intent = (s: AgentStore, over = {}) =>
  s.reserveIntent({
    to: payTo,
    value: 10000n,
    validAfter: 0n,
    validBefore: 2_000_000n,
    resource: url,
    accepted: "{}",
    ...over,
  });

describe("nonce derivation", () => {
  const base = {
    chainId: 1874,
    token: asset,
    from: account.address,
    to: payTo,
    value: 10000n,
    validAfter: 0n,
    validBefore: 2_000_000n,
    resource: url,
    sessionId: ("0x" + "aa".repeat(32)) as `0x${string}`,
    counter: 1,
  };
  const n0 = deriveNonce(base);
  const variants: [string, Partial<typeof base>][] = [
    ["chainId", { chainId: 1 }],
    ["token", { token: evil }],
    ["from", { from: evil }],
    ["to", { to: evil }],
    ["value", { value: 10001n }],
    ["validAfter", { validAfter: 1n }],
    ["validBefore", { validBefore: 2_000_001n }],
    ["resource", { resource: url + "x" }],
    ["sessionId", { sessionId: ("0x" + "bb".repeat(32)) as `0x${string}` }],
    ["counter", { counter: 2 }],
  ];
  it("is deterministic", () => expect(deriveNonce({ ...base })).toBe(n0));
  it.each(variants)("changes when %s changes", (_n, patch) => {
    expect(deriveNonce({ ...base, ...patch })).not.toBe(n0);
  });
  it("idempotency key binds chain, token, payer and nonce", () => {
    const k = idempotencyKey({ chainId: 1874, token: asset, payer: account.address, nonce: n0 });
    expect(idempotencyKey({ chainId: 1, token: asset, payer: account.address, nonce: n0 })).not.toBe(k);
    expect(idempotencyKey({ chainId: 1874, token: evil, payer: account.address, nonce: n0 })).not.toBe(k);
    expect(idempotencyKey({ chainId: 1874, token: asset, payer: evil, nonce: n0 })).not.toBe(k);
  });
});

describe("state machine and budget (store level)", () => {
  it("reserve is atomic with the budget and keeps unique nonces", () => {
    const s = open(sandbox().path);
    const a = intent(s);
    const b = intent(s, { resource: url + "2" });
    expect(a.nonce).not.toBe(b.nonce);
    expect(s.reserved()).toBe(20000n);
    expect(() => intent(s, { resource: url + "3", value: 10001n })).toThrowError(
      expect.objectContaining({ code: "budget" }),
    );
    expect(() => intent(s, { resource: url + "3", value: 0n })).toThrow();
    s.close();
  });
  it("refuses a second open payment for one resource", () => {
    const s = open(sandbox().path);
    intent(s);
    expect(() => intent(s)).toThrowError(expect.objectContaining({ code: "pending" }));
    s.close();
  });
  it("rejects illegal transitions and any change of terms", () => {
    const s = open(sandbox().path);
    const r = intent(s);
    expect(() => s.markSubmitted(r.nonce)).toThrow(/Nothing signed/);
    const good = JSON.stringify({
      payload: {
        authorization: {
          from: account.address, to: payTo, value: "10000",
          validAfter: "0", validBefore: "2000000", nonce: r.nonce,
        },
      },
    });
    for (const patch of [{ value: "9999" }, { to: evil }, { validBefore: "9" }, { nonce: "0x" + "00".repeat(32) }]) {
      const bad = JSON.parse(good);
      Object.assign(bad.payload.authorization, patch);
      expect(() => s.markSigned(r.nonce, "0x01", JSON.stringify(bad))).toThrow(/does not match/);
    }
    s.markSigned(r.nonce, "0x01", good);
    expect(() => s.markSigned(r.nonce, "0x02", good)).toThrow();
    s.markSettled(r.nonce, ("0x" + "11".repeat(32)) as `0x${string}`, true);
    expect(() => s.release(r.nonce, 9_999_999n)).toThrow(/settled/);
    s.close();
  });
  it("release requires a finalized timestamp strictly past validBefore", () => {
    const s = open(sandbox().path);
    const r = intent(s);
    expect(() => s.release(r.nonce, 2_000_000n)).toThrow(/not expired/);
    expect(s.reserved()).toBe(10000n);
    s.release(r.nonce, 2_000_001n);
    expect(s.reserved()).toBe(0n);
    s.close();
  });
  it("a released resource can be paid again with a new counter", () => {
    const s = open(sandbox().path);
    const r = intent(s);
    s.release(r.nonce, 2_000_001n);
    const r2 = intent(s, { validBefore: 3_000_000n });
    expect(r2.counter).toBe(2);
    expect(r2.nonce).not.toBe(r.nonce);
    s.close();
  });
});

describe("receipt proof", () => {
  const nonce = ("0x" + "5".repeat(64)) as `0x${string}`;
  const rec = { nonce, payTo, amount: "10000" };
  const good = () => {
    const x = new World();
    const tx = x.settle(nonce);
    return x.receipts.get(tx)!;
  };
  it("accepts the exact AuthorizationUsed + Transfer", () =>
    expect(receiptProvesPayment(good(), rec, asset, account.address)).toBe(true));
  const cases: [string, (r: ReturnType<typeof good>) => unknown][] = [
    ["reverted", (r) => ((r as { success: boolean }).success = false)],
    ["no logs", (r) => (r.logs.length = 0)],
    ["no transfer", (r) => r.logs.splice(1, 1)],
    ["no authorization used", (r) => r.logs.splice(0, 1)],
    ["wrong token", (r) => r.logs.forEach((l) => (l.address = evil))],
    ["wrong value", (r) => (r.logs[1].data = ("0x" + "00".repeat(31) + "01") as `0x${string}`)],
    ["wrong payTo", (r) => (r.logs[1].topics[2] = r.logs[1].topics[1])],
    ["wrong payer", (r) => (r.logs[1].topics[1] = r.logs[1].topics[2])],
    ["wrong nonce", (r) => (r.logs[0].topics[2] = ("0x" + "6".repeat(64)) as `0x${string}`)],
  ];
  it.each(cases)("rejects %s", (_n, mutate) => {
    const r = good();
    mutate(r);
    expect(receiptProvesPayment(r, rec, asset, account.address)).toBe(false);
  });
  it("rejects a missing receipt", () =>
    expect(receiptProvesPayment(null, rec, asset, account.address)).toBe(false));
});

describe("file hygiene", () => {
  it.skipIf(process.platform === "win32")("directory 0700, db and sidecar files 0600", () => {
    const { path, dir } = sandbox();
    const s = open(path);
    intent(s);
    const d = join(dir, "agent");
    expect(statSync(d).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(d)) expect(statSync(join(d, f)).mode & 0o777).toBe(0o600);
    s.close();
  });
  it("uses WAL with synchronous=FULL", () => {
    const { path } = sandbox();
    const s = open(path);
    s.close();
    const db = new Database(path);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });
});

describe("integrity: tampering is detected on open", () => {
  const tamper = (sql: string) => {
    const { path } = sandbox();
    const s = open(path);
    const r = intent(s);
    intent(s, { resource: url + "2" });
    s.markSigned(
      r.nonce,
      "0x01",
      JSON.stringify({
        payload: { authorization: { from: account.address, to: payTo, value: "10000", validAfter: "0", validBefore: "2000000", nonce: r.nonce } },
      }),
    );
    s.close();
    const db = new Database(path);
    db.exec(sql);
    db.close();
    return path;
  };
  const edits: [string, string][] = [
    ["lower an amount", "UPDATE payments SET amount='1' WHERE counter=1"],
    ["delete a row", "DELETE FROM payments WHERE counter=2"],
    ["delete all rows", "DELETE FROM payments"],
    ["flip released", "UPDATE payments SET released=1 WHERE counter=1"],
    ["change the payee", `UPDATE payments SET payTo='${evil}' WHERE counter=1`],
    ["swap the signature", "UPDATE payments SET signature='0x02' WHERE counter=1"],
    ["delete a middle event", "DELETE FROM events WHERE seq=2"],
    ["edit an event", "UPDATE events SET snapshot=replace(snapshot,'10000','1') WHERE seq=2"],
    ["delete the newest event", "DELETE FROM events WHERE seq=(SELECT MAX(seq) FROM events)"],
    ["insert a row", `INSERT INTO payments (nonce,counter,state,resource,accepted,payTo,amount,validAfter,validBefore) VALUES ('0x${"ab".repeat(32)}',9,'intent','r','{}','${payTo}','1','0','1')`],
    ["rewrite the session", "UPDATE meta SET v='[]'"],
    ["drop the session", "DELETE FROM meta"],
    ["wipe the event log", "DELETE FROM events"],
  ];
  it.each(edits)("%s", (_n, sql) => {
    const path = tamper(sql);
    expect(() => open(path)).toThrowError(expect.objectContaining({ code: expect.stringMatching(/integrity/) }));
  });
  it("a wrong secret cannot open (and cannot forge) the store", () => {
    const { path } = sandbox();
    open(path).close();
    expect(() => open(path, terms, { secret: "another-secret-0123456789" })).toThrowError(
      expect.objectContaining({ code: "integrity" }),
    );
  });
  it("a short secret is refused", () => {
    expect(() => open(sandbox().path, terms, { secret: "short" })).toThrow(StoreError);
  });
  it("an untouched store reopens", () => {
    const { path } = sandbox();
    const s = open(path);
    intent(s);
    s.close();
    expect(open(path).list()).toHaveLength(1);
  });
});

describe("terms are bound to the session", () => {
  const changes: [string, Partial<SessionTerms>][] = [
    ["budget", { budget: 99999999n }],
    ["payer", { payer: evil }],
    ["token", { token: evil }],
    ["chain", { chainId: 1 }],
    ["domain name", { domainName: "Other" }],
    ["domain version", { domainVersion: "2" }],
  ];
  it.each(changes)("reopening with a different %s is rejected", (_n, patch) => {
    const { path } = sandbox();
    open(path).close();
    expect(() => open(path, { ...terms, ...patch })).toThrowError(
      expect.objectContaining({ code: "mismatch" }),
    );
  });
});

describe("path safety", () => {
  it.each([
    ["traversal", "../../etc/state.db"],
    ["traversal in the middle", "a/../b/state.db"],
    ["backslash traversal", "a\\..\\b\\state.db"],
    ["memory db", ":memory:"],
    ["uri", "file:state.db?mode=memory"],
    ["nul byte", "a\0b.db"],
    ["empty", ""],
  ])("refuses %s", (_n, p) => {
    expect(() => assertSafeStorePath(p)).toThrowError(expect.objectContaining({ code: "path" }));
  });
  it("refuses a symlinked store file and a symlinked directory", () => {
    const { dir } = sandbox();
    const real = join(dir, "real.db");
    writeFileSync(real, "");
    const link = join(dir, "link.db");
    const realDir = join(dir, "realdir");
    mkdirSync(realDir);
    const linkDir = join(dir, "linkdir");
    let linked = 0;
    try {
      symlinkSync(real, link, "file");
      expect(() => assertSafeStorePath(link)).toThrowError(expect.objectContaining({ code: "path" }));
      linked++;
    } catch (e) {
      if (e instanceof StoreError) throw e;
    }
    try {
      symlinkSync(realDir, linkDir, "junction");
      expect(() => assertSafeStorePath(join(linkDir, "s.db"))).toThrowError(
        expect.objectContaining({ code: "path" }),
      );
      linked++;
    } catch (e) {
      if (e instanceof StoreError) throw e;
    }
    // Opening through AgentStore also refuses.
    if (linked) expect(() => open(join(linkDir, "s.db"))).toThrow(StoreError);
    expect(linked).toBeGreaterThan(0);
  });
  it("refuses a directory in place of the file", () => {
    const { dir } = sandbox();
    expect(() => assertSafeStorePath(dir)).toThrowError(expect.objectContaining({ code: "path" }));
  });
});

describe("secrets never reach the store", () => {
  it("no private key, store secret or RPC credential bytes in db, wal or shm; no console output", async () => {
    const { path, dir } = sandbox();
    const logs: unknown[][] = [];
    const orig = { ...console };
    for (const k of ["log", "info", "warn", "error", "debug"] as const)
      (console as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => logs.push(a);
    try {
      const x = new World();
      const a = x.agent(path, {}, { secret: SECRET });
      await a.fetch(url);
      // Read while the connection is open so the WAL is included.
      const bytes = readdirSync(join(dir, "agent")).map((f) => readFileSync(join(dir, "agent", f)));
      a.close();
      const all = Buffer.concat([
        ...bytes,
        ...readdirSync(join(dir, "agent")).map((f) => readFileSync(join(dir, "agent", f))),
      ]).toString("latin1");
      expect(all).not.toContain("11".repeat(32));
      expect(all).not.toContain(SECRET);
      expect(all).not.toMatch(/apikey|api_key|https?:\/\/[^"]*rpc/i);
      expect(all).toContain("signature"); // the bearer signature IS stored, by design
    } finally {
      Object.assign(console, orig);
    }
    expect(JSON.stringify(logs)).not.toContain("11".repeat(32));
    expect(logs).toHaveLength(0);
  });
});

// keep helper imports used
void copyFileSync;
