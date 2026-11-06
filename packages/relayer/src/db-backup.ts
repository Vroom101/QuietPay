import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Db } from "./db.js";
import { acquireInstanceLock } from "./instance-lock.js";

/**
 * Online backup and guarded restore of the relayer SQLite database.
 *
 * Backups use SQLite's online backup API (better-sqlite3 `.backup()`), which copies a consistent snapshot
 * while the relayer keeps writing; copying the file would race with the WAL. Every backup is verified
 * (PRAGMA integrity_check), stamped with the chain id and router the database belongs to, and written next to a
 * `.sha256` file. Restore refuses anything it cannot positively verify.
 */

export interface DbIdentity {
  chainId: number;
  router: string;
}

const REQUIRED_TABLES = ["orders", "refunds", "deliveries", "x402_payments", "settings", "tx_attempts"];
const K_CHAIN = "deploy_chain_id";
const K_ROUTER = "deploy_router";

/** Records the chain and router this database serves; refuses to continue if it was recorded for another. */
export function recordDbIdentity(db: Pick<Db, "getSetting" | "setSetting">, id: DbIdentity): void {
  const router = id.router.toLowerCase();
  const chain = db.getSetting(K_CHAIN);
  const rt = db.getSetting(K_ROUTER);
  if (chain !== undefined && chain !== String(id.chainId)) throw new Error(`database is recorded for chain ${chain}, not ${id.chainId}`);
  if (rt !== undefined && rt !== router) throw new Error(`database is recorded for router ${rt}, not ${router}`);
  if (chain === undefined) db.setSetting(K_CHAIN, String(id.chainId));
  if (rt === undefined) db.setSetting(K_ROUTER, router);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readIdentity(d: Database.Database): { chain?: string; router?: string } {
  const has = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
  if (!has) return {};
  const get = (k: string) => (d.prepare("SELECT value FROM settings WHERE key=?").get(k) as { value: string } | undefined)?.value;
  return { chain: get(K_CHAIN), router: get(K_ROUTER) };
}

function integrity(d: Database.Database): string {
  return String(d.pragma("integrity_check", { simple: true }));
}

function tables(d: Database.Database): Set<string> {
  return new Set((d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
}

export interface BackupResult {
  path: string;
  sha256: string;
  integrity: string;
  bytes: number;
}

/** Online backup of `srcPath` into `destPath` (atomic rename; a sibling `.sha256` file is written). */
export async function backupDb(srcPath: string, destPath: string, ident?: DbIdentity): Promise<BackupResult> {
  if (!existsSync(srcPath)) throw new Error(`database not found: ${srcPath}`);
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.partial-${process.pid}`;
  const src = new Database(srcPath, { fileMustExist: true });
  try {
    src.pragma("busy_timeout = 5000");
    const sid = readIdentity(src);
    if (ident) {
      if (sid.chain !== undefined && sid.chain !== String(ident.chainId)) throw new Error(`database is recorded for chain ${sid.chain}, not ${ident.chainId}`);
      if (sid.router !== undefined && sid.router !== ident.router.toLowerCase()) throw new Error(`database is recorded for router ${sid.router}, not ${ident.router.toLowerCase()}`);
    }
    await src.backup(tmp);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    src.close();
  }
  try {
    const d = new Database(tmp);
    try {
      const chk = integrity(d);
      if (chk !== "ok") throw new Error(`backup failed integrity_check: ${chk}`);
      if (ident) {
        const id = readIdentity(d);
        if (id.chain === undefined) d.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(K_CHAIN, String(ident.chainId));
        if (id.router === undefined) d.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(K_ROUTER, ident.router.toLowerCase());
      }
      d.pragma("journal_mode = DELETE"); // one self-contained file
    } finally {
      d.close();
    }
    const sum = sha256File(tmp);
    writeFileSync(`${destPath}.sha256`, `${sum}  ${basename(destPath)}\n`);
    renameSync(tmp, destPath);
    const chk = new Database(destPath, { readonly: true });
    try {
      return { path: destPath, sha256: sum, integrity: integrity(chk), bytes: readFileSync(destPath).length };
    } finally {
      chk.close();
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export interface RestoreOptions {
  /** Replace an existing database at the target path. */
  force?: boolean;
  /** Accept a backup that has no .sha256 file (identity and integrity are still verified). */
  skipChecksum?: boolean;
}

/**
 * Restores `backupPath` to `targetPath` after verifying checksum, integrity, schema and that the backup was
 * recorded for exactly `expected.chainId` and `expected.router`. Takes the single-instance lock on the
 * target, so it refuses while a relayer is running on it.
 */
export async function restoreDb(backupPath: string, targetPath: string, expected: DbIdentity, opts: RestoreOptions = {}): Promise<{ path: string; integrity: string }> {
  if (!existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
  const sumFile = `${backupPath}.sha256`;
  if (existsSync(sumFile)) {
    const want = readFileSync(sumFile, "utf8").trim().split(/\s+/)[0];
    if (want !== sha256File(backupPath)) throw new Error("backup checksum mismatch: the file was modified after it was written");
  } else if (!opts.skipChecksum) {
    throw new Error(`backup checksum file missing (${sumFile}); refusing an unverifiable backup`);
  }
  let d: Database.Database;
  try {
    d = new Database(backupPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    throw new Error(`backup is not a readable database: ${(e as Error).message}`);
  }
  try {
    let chk: string;
    try {
      chk = integrity(d);
    } catch (e) {
      throw new Error(`backup failed integrity_check: ${(e as Error).message}`);
    }
    if (chk !== "ok") throw new Error(`backup failed integrity_check: ${chk.slice(0, 200)}`);
    const have = tables(d);
    const missing = REQUIRED_TABLES.filter((t) => !have.has(t));
    if (missing.length) throw new Error(`backup is missing relayer table(s): ${missing.join(", ")}`);
    const id = readIdentity(d);
    if (id.chain === undefined || id.router === undefined) throw new Error("backup has no recorded chain/router identity; refusing to guess");
    if (id.chain !== String(expected.chainId)) throw new Error(`backup was recorded for chain ${id.chain}, expected ${expected.chainId}`);
    if (id.router !== expected.router.toLowerCase()) throw new Error(`backup was recorded for router ${id.router}, expected ${expected.router.toLowerCase()}`);
  } finally {
    d.close();
  }
  if (existsSync(targetPath) && !opts.force) throw new Error(`target database exists (${targetPath}); pass force to replace it`);
  mkdirSync(dirname(targetPath), { recursive: true });
  const lock = acquireInstanceLock(targetPath);
  const tmp = `${targetPath}.restore-${process.pid}`;
  try {
    const src = new Database(backupPath, { readonly: true });
    try {
      await src.backup(tmp);
    } finally {
      src.close();
    }
    const t = new Database(tmp);
    let res: string;
    try {
      res = integrity(t);
      t.pragma("journal_mode = WAL");
    } finally {
      t.close();
    }
    if (res !== "ok") throw new Error(`restored copy failed integrity_check: ${res}`);
    for (const ext of ["-wal", "-shm"]) rmSync(targetPath + ext, { force: true });
    renameSync(tmp, targetPath);
    for (const ext of ["-wal", "-shm"]) rmSync(tmp + ext, { force: true });
    return { path: targetPath, integrity: res };
  } finally {
    rmSync(tmp, { force: true });
    for (const ext of ["-wal", "-shm"]) rmSync(tmp + ext, { force: true });
    lock.release();
  }
}

/** Deletes all but the newest `keep` files named quietpay-*.db (and their .sha256). Returns removed names. */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("keep must be an integer >= 1");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^quietpay-.+\.db$/.test(f))
    .sort(); // names carry a UTC timestamp, so lexical order is age order
  const drop = files.slice(0, Math.max(0, files.length - keep));
  for (const f of drop) {
    rmSync(join(dir, f), { force: true });
    rmSync(join(dir, `${f}.sha256`), { force: true });
  }
  return drop;
}
