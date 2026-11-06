import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { acquireInstanceLock } from "../src/instance-lock.js";
import { backupDb, pruneBackups, recordDbIdentity, restoreDb } from "../src/db-backup.js";

const ROUTER = "0xb9D475cdd817900B45C356169c6FdC379B942d82";
const IDENT = { chainId: 1874, router: ROUTER };
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "b-build-w3-bk-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(db: Db, n = 1) {
  for (let i = 0; i < n; i++) {
    db.raw
      .prepare("INSERT INTO orders (id,merchant_id,amount,fee,payout,status,nonce,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(`0xo${i}`, "0x" + "01".repeat(32), "1000000", "50000", "950000", "settled", `0xn${i}`, 100 + i, 9_999_999_999);
    db.raw
      .prepare("INSERT INTO refunds (id,order_id,merchant_id,amount,refund_index,status,signature,valid_after,valid_before,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(`0xr${i}`, `0xo${i}`, "0x" + "01".repeat(32), "10", 0, "pending", "0xsig", 1, 2, 3);
    db.raw
      .prepare("INSERT INTO deliveries (id,order_id,url,body,attempts,next_attempt_at) VALUES (?,?,?,?,?,?)")
      .run(`d${i}`, `0xo${i}`, "https://shop.example.com/h", "{}", 0, 0);
    db.raw
      .prepare("INSERT INTO x402_payments (id,payer,nonce,merchant_id,resource,pay_to,amount,fingerprint,request,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(`x${i}`, "0xpayer", `0xxn${i}`, "0x" + "02".repeat(32), "https://api.example.com/q", "0xpay", "10000", "fp", "{}", "settled", 5);
  }
}

const counts = (path: string) => {
  const d = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(["orders", "refunds", "deliveries", "x402_payments"].map((t) => [t, (d.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c]));
  } finally {
    d.close();
  }
};

describe("Feature: relayer database backup and restore / Scenario: happy path", () => {
  it("Given a live database, When backed up and restored elsewhere, Then orders, refunds, deliveries and x402 rows are identical", async () => {
    const dir = tmp();
    const src = join(dir, "live.db");
    const db = new Db(src);
    recordDbIdentity(db, IDENT);
    seed(db, 3);
    const bk = join(dir, "bk", "quietpay-1.db");
    const r = await backupDb(src, bk, IDENT);
    expect(r.integrity).toBe("ok");
    expect(existsSync(bk + ".sha256")).toBe(true);
    db.close();

    const target = join(dir, "restored.db");
    const out = await restoreDb(bk, target, IDENT);
    expect(out.integrity).toBe("ok");
    expect(counts(target)).toEqual({ orders: 3, refunds: 3, deliveries: 3, x402_payments: 3 });
    const a = new Database(src, { readonly: true });
    const b = new Database(target, { readonly: true });
    for (const t of ["orders", "refunds", "deliveries", "x402_payments"]) {
      expect(b.prepare(`SELECT * FROM ${t} ORDER BY id`).all()).toEqual(a.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
    }
    a.close();
    b.close();
    // The restored file opens with the normal Db class.
    const re = new Db(target);
    expect(re.getSetting("deploy_chain_id")).toBe("1874");
    re.close();
  });

  it("backs up a database that is being written to; the copy passes PRAGMA integrity_check", async () => {
    const dir = tmp();
    const src = join(dir, "live.db");
    const db = new Db(src);
    recordDbIdentity(db, IDENT);
    seed(db, 50);
    let i = 1000;
    const spin = setInterval(() => {
      for (let k = 0; k < 20; k++) {
        db.raw
          .prepare("INSERT INTO orders (id,merchant_id,amount,fee,payout,status,nonce,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(`0xw${i++}`, "0x" + "01".repeat(32), "1", "0", "1", "created", `0xwn${i}`, i, 9_999_999_999);
      }
    }, 1);
    try {
      const bk = join(dir, "bk.db");
      const r = await backupDb(src, bk, IDENT);
      expect(r.integrity).toBe("ok");
      const chk = new Database(bk, { readonly: true });
      expect(chk.pragma("integrity_check", { simple: true })).toBe("ok");
      chk.close();
    } finally {
      clearInterval(spin);
      db.close();
    }
  });
});

describe("Scenario: restore refusals", () => {
  async function made() {
    const dir = tmp();
    const src = join(dir, "live.db");
    const db = new Db(src);
    recordDbIdentity(db, IDENT);
    seed(db, 2);
    db.close();
    const bk = join(dir, "bk.db");
    await backupDb(src, bk, IDENT);
    return { dir, src, bk };
  }

  it("refuses a database recorded for a different chain", async () => {
    const { dir, bk } = await made();
    await expect(restoreDb(bk, join(dir, "t.db"), { chainId: 1, router: ROUTER })).rejects.toThrow(/chain/i);
    expect(existsSync(join(dir, "t.db"))).toBe(false);
  });

  it("refuses a database recorded for a different router", async () => {
    const { dir, bk } = await made();
    await expect(restoreDb(bk, join(dir, "t.db"), { chainId: 1874, router: "0x" + "11".repeat(20) })).rejects.toThrow(/router/i);
    expect(existsSync(join(dir, "t.db"))).toBe(false);
  });

  it("compares the router case-insensitively", async () => {
    const { dir, bk } = await made();
    await restoreDb(bk, join(dir, "t.db"), { chainId: 1874, router: ROUTER.toLowerCase() });
    expect(existsSync(join(dir, "t.db"))).toBe(true);
  });

  it("refuses a backup with no recorded identity", async () => {
    const dir = tmp();
    const raw = join(dir, "old.db");
    const db = new Db(raw);
    seed(db, 1);
    db.close();
    const bk = join(dir, "bk.db");
    copyFileSync(raw, bk);
    await expect(restoreDb(bk, join(dir, "t.db"), IDENT, { skipChecksum: true })).rejects.toThrow(/not recorded|identity/i);
  });

  it("refuses a tampered backup (bytes changed after the checksum was written)", async () => {
    const { dir, bk } = await made();
    const buf = readFileSync(bk);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    writeFileSync(bk, buf);
    await expect(restoreDb(bk, join(dir, "t.db"), IDENT)).rejects.toThrow(/checksum|integrity/i);
    expect(existsSync(join(dir, "t.db"))).toBe(false);
  });

  it("refuses an edited identity (valid SQLite file, stale checksum)", async () => {
    const { dir, bk } = await made();
    const d = new Database(bk);
    d.prepare("UPDATE settings SET value='0x" + "22".repeat(20) + "' WHERE key='deploy_router'").run();
    d.close();
    await expect(restoreDb(bk, join(dir, "t.db"), IDENT)).rejects.toThrow(/checksum/i);
  });

  it("refuses a backup whose checksum file is missing, unless explicitly skipped", async () => {
    const { dir, bk } = await made();
    rmSync(bk + ".sha256");
    await expect(restoreDb(bk, join(dir, "t.db"), IDENT)).rejects.toThrow(/checksum/i);
    await restoreDb(bk, join(dir, "t.db"), IDENT, { skipChecksum: true });
  });

  it("refuses a file that is not a database", async () => {
    const dir = tmp();
    const bk = join(dir, "junk.db");
    writeFileSync(bk, "this is not sqlite");
    await expect(restoreDb(bk, join(dir, "t.db"), IDENT, { skipChecksum: true })).rejects.toThrow();
  });

  it("refuses a database missing the relayer tables", async () => {
    const dir = tmp();
    const bk = join(dir, "x.db");
    const d = new Database(bk);
    d.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('deploy_chain_id','1874'),('deploy_router','" + ROUTER.toLowerCase() + "');");
    d.close();
    await expect(restoreDb(bk, join(dir, "t.db"), IDENT, { skipChecksum: true })).rejects.toThrow(/table/i);
  });

  it("refuses to overwrite an existing database without force, and while a relayer holds the lock", async () => {
    const { dir, src, bk } = await made();
    await expect(restoreDb(bk, src, IDENT)).rejects.toThrow(/exists|force/i);
    const lock = acquireInstanceLock(src);
    await expect(restoreDb(bk, src, IDENT, { force: true })).rejects.toThrow(/already using/);
    lock.release();
    const before = counts(src);
    await restoreDb(bk, src, IDENT, { force: true });
    expect(counts(src)).toEqual(before);
    expect(readdirSync(dir).filter((f) => f.includes(".restore-"))).toEqual([]);
  });
});

describe("recordDbIdentity", () => {
  it("records once and then refuses a different chain or router", () => {
    const db = new Db(":memory:");
    recordDbIdentity(db, IDENT);
    recordDbIdentity(db, { chainId: 1874, router: ROUTER.toLowerCase() });
    expect(() => recordDbIdentity(db, { chainId: 1, router: ROUTER })).toThrow(/chain/i);
    expect(() => recordDbIdentity(db, { chainId: 1874, router: "0x" + "33".repeat(20) })).toThrow(/router/i);
  });
});

describe("retention", () => {
  it("keeps the newest N backups with their checksum files and removes the rest", async () => {
    const dir = tmp();
    const src = join(dir, "live.db");
    const db = new Db(src);
    recordDbIdentity(db, IDENT);
    db.close();
    const bdir = join(dir, "bk");
    for (const n of ["20260101T000000Z", "20260102T000000Z", "20260103T000000Z", "20260104T000000Z"]) {
      await backupDb(src, join(bdir, `quietpay-${n}.db`), IDENT);
    }
    writeFileSync(join(bdir, "unrelated.txt"), "keep me");
    const removed = pruneBackups(bdir, 2);
    expect(removed.sort()).toEqual(["quietpay-20260101T000000Z.db", "quietpay-20260102T000000Z.db"]);
    expect(readdirSync(bdir).sort()).toEqual([
      "quietpay-20260103T000000Z.db",
      "quietpay-20260103T000000Z.db.sha256",
      "quietpay-20260104T000000Z.db",
      "quietpay-20260104T000000Z.db.sha256",
      "unrelated.txt",
    ]);
    expect(() => pruneBackups(bdir, 0)).toThrow();
  });
});

describe("CLI (src/db-cli.ts)", () => {
  it("backup then restore through the command line; a wrong router is refused with exit 1", async () => {
    const { spawnSync } = await import("node:child_process");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const dir = tmp();
    const dbp = join(dir, "live.db");
    const db = new Db(dbp);
    recordDbIdentity(db, IDENT);
    seed(db, 2);
    db.close();
    const run = (args: string[], env: Record<string, string>) =>
      spawnSync(process.execPath, ["--import", "tsx", join(root, "src", "db-cli.ts"), ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
    const base = { DATABASE_PATH: dbp, CHAIN_ID: "1874", ROUTER_ADDRESS: ROUTER, BACKUP_DIR: join(dir, "bk"), BACKUP_KEEP: "2" };
    const b = run(["backup"], base);
    expect(b.status, b.stderr).toBe(0);
    const info = JSON.parse(b.stdout.trim()) as { backup: string; integrity: string };
    expect(info.integrity).toBe("ok");
    const target = join(dir, "r.db");
    const r = run(["restore", info.backup], { ...base, DATABASE_PATH: target });
    expect(r.status, r.stderr).toBe(0);
    expect(counts(target).orders).toBe(2);
    const bad = run(["restore", info.backup, "--force"], { ...base, DATABASE_PATH: target, ROUTER_ADDRESS: "0x" + "44".repeat(20) });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/router/i);
  }, 60_000);
});
