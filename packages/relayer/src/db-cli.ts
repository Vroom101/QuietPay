import { join } from "node:path";
import { backupDb, pruneBackups, restoreDb } from "./db-backup.js";

/**
 * Operator CLI for the relayer database. Reads DATABASE_PATH, CHAIN_ID and ROUTER_ADDRESS from the environment
 * (no signing key or other secret is needed).
 *
 *   tsx src/db-cli.ts backup  [--dir <backupDir>] [--keep <n>]     online backup, verify, prune old ones
 *   tsx src/db-cli.ts restore <backupFile> [--force] [--target <path>]
 *
 * BACKUP_DIR (default /data/backups) and BACKUP_KEEP (default 14) apply when the flags are omitted.
 * Restore needs the relayer stopped: it takes the same lock file and refuses otherwise.
 */
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => {
  const i = rest.indexOf(n);
  return i >= 0 ? rest[i + 1] : undefined;
};
const need = (n: string) => {
  const v = process.env[n];
  if (!v) {
    console.error(`${n} is required`);
    process.exit(2);
  }
  return v;
};

try {
  const dbPath = flag("--target") ?? process.env.DATABASE_PATH ?? "./quietpay.db";
  const ident = { chainId: Number(process.env.CHAIN_ID ?? "1874"), router: need("ROUTER_ADDRESS") };
  if (cmd === "backup") {
    const dir = flag("--dir") ?? process.env.BACKUP_DIR ?? "/data/backups";
    const keep = Number(flag("--keep") ?? process.env.BACKUP_KEEP ?? "14");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const r = await backupDb(dbPath, join(dir, `quietpay-${stamp}.db`), ident);
    const removed = pruneBackups(dir, keep);
    console.log(JSON.stringify({ ok: true, backup: r.path, bytes: r.bytes, sha256: r.sha256, integrity: r.integrity, pruned: removed.length }));
  } else if (cmd === "restore") {
    const file = rest.find((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1] !== "--target");
    if (!file) throw new Error("usage: restore <backupFile> [--force] [--target <path>]");
    const r = await restoreDb(file, dbPath, ident, { force: rest.includes("--force") });
    console.log(JSON.stringify({ ok: true, restored: r.path, integrity: r.integrity }));
  } else {
    console.error("usage: db-cli.ts backup|restore ...");
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
