import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";

/**
 * Single-instance guard for a relayer database file.
 *
 * SQLite tolerates several processes, but each relayer process manages the signing key's nonce on its own,
 * so two relayers on one database would collide on nonces. A lock file `<db>.lock` is created with the
 * exclusive-create flag (O_CREAT|O_EXCL: the operating system lets exactly one creator win) and holds the
 * owner's pid and host. It is removed on exit. A lock left behind by a crashed or killed process is stale
 * (its pid is no longer alive on this host) and is taken over; takeover itself is serialised through a second
 * exclusive file so two newcomers cannot both claim the same stale lock.
 *
 * Limits: the check is between QuietPay processes on one host sharing one disk. A pid reused by an unrelated
 * process after a hard crash makes the lock look live; delete `<db>.lock` after confirming no relayer runs.
 */
export interface InstanceLock {
  readonly path: string;
  release(): void;
}

interface LockBody {
  pid: number;
  host: string;
  at: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readBody(path: string): LockBody | null {
  try {
    const b = JSON.parse(readFileSync(path, "utf8")) as LockBody;
    return typeof b.pid === "number" && Number.isInteger(b.pid) && b.pid > 0 ? b : null;
  } catch {
    return null;
  }
}

function isStale(path: string): boolean {
  const b = readBody(path);
  if (!b) return true; // empty or garbage: the writer died mid-write
  if (b.host !== hostname()) return false; // another host on a shared disk: cannot judge, keep refusing
  return !alive(b.pid);
}

function tryCreate(path: string): boolean {
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() } satisfies LockBody));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

const rm = (p: string) => {
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
};

export function acquireInstanceLock(dbPath: string): InstanceLock {
  if (dbPath === ":memory:" || dbPath === "") return { path: "", release: () => undefined };
  const path = `${dbPath}.lock`;
  const refuse = (): never => {
    const b = readBody(path);
    throw new Error(
      `another relayer process (pid ${b?.pid ?? "unknown"}${b ? ` on ${b.host}` : ""}) is already using the database ${dbPath}. ` +
        `Run exactly one relayer per database; if no relayer is running, delete ${path}.`,
    );
  };
  let got = tryCreate(path);
  if (!got) {
    if (!isStale(path)) refuse();
    const guard = `${path}.reclaim`;
    if (!tryCreate(guard)) {
      // Someone else is reclaiming right now, or died doing it: a dead guard is cleared once.
      if (isStale(guard)) rm(guard);
      if (!tryCreate(guard)) refuse();
    }
    try {
      if (isStale(path)) {
        const tomb = `${path}.stale-${process.pid}`;
        try {
          renameSync(path, tomb);
        } catch {
          /* already gone */
        }
        rm(tomb);
      }
      got = tryCreate(path);
    } finally {
      rm(guard);
    }
    if (!got) refuse();
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    const b = readBody(path);
    if (b && b.pid === process.pid && existsSync(path)) rm(path);
  };
  process.on("exit", release);
  return { path, release };
}
