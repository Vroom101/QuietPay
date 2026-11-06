import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../src/instance-lock.js";

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const kids: ChildProcessWithoutNullStreams[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "b-build-w3-lock-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const k of kids.splice(0)) k.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function child(db: string, mode = "hold") {
  const p = spawn(process.execPath, ["--import", "tsx", join(here, "fixtures", "build-lock-child.ts"), db, mode], { cwd: join(here, ".."), stdio: "pipe" });
  kids.push(p);
  let out = "";
  let err = "";
  p.stdout.on("data", (c) => (out += c));
  p.stderr.on("data", (c) => (err += c));
  const exited = new Promise<number | null>((r) => p.on("exit", (c) => r(c)));
  const until = async (what: () => boolean) => {
    const end = Date.now() + 30_000;
    while (!what()) {
      if (Date.now() > end) throw new Error(`timeout; out=${out} err=${err}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { p, exited, out: () => out, err: () => err, until };
}

describe("Feature: single-instance lock / Scenario: second process on the same database file", () => {
  it("Given one holder, When a second process starts on the same file, Then it refuses with a clear error", async () => {
    const db = join(tmp(), "q.db");
    const a = child(db);
    await a.until(() => a.out().includes("LOCKED"));
    const b = child(db);
    expect(await b.exited).toBe(3);
    expect(b.err()).toMatch(/REFUSED: .*another relayer process .*already using/i);
    expect(b.err()).toContain("q.db");
    expect(a.p.exitCode).toBeNull(); // the holder is undisturbed
  }, 90_000);

  it("When the holder exits cleanly, Then the lock file is gone and a new process starts", async () => {
    const db = join(tmp(), "q.db");
    const a = child(db, "exit-now");
    expect(await a.exited).toBe(0);
    expect(existsSync(db + ".lock")).toBe(false);
    const b = child(db, "exit-now");
    expect(await b.exited).toBe(0);
  }, 90_000);

  it("When the holder is killed (stale lock left behind), Then a new process takes over", async () => {
    const db = join(tmp(), "q.db");
    const a = child(db);
    await a.until(() => a.out().includes("LOCKED"));
    a.p.kill("SIGKILL");
    await a.exited;
    expect(existsSync(db + ".lock")).toBe(true);
    const b = child(db, "exit-now");
    expect(await b.exited).toBe(0);
  }, 90_000);
});

describe("instance lock (in process)", () => {
  it("refuses a second acquire in the same process, releases, then allows again", () => {
    const db = join(tmp(), "q.db");
    const l = acquireInstanceLock(db);
    expect(() => acquireInstanceLock(db)).toThrow(/already using/);
    l.release();
    l.release(); // idempotent
    acquireInstanceLock(db).release();
  });

  it("a lock file naming a dead pid is stale; garbage content is stale; a live foreign pid blocks", () => {
    const db = join(tmp(), "q.db");
    writeFileSync(db + ".lock", JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), at: 1 }));
    acquireInstanceLock(db).release();
    writeFileSync(db + ".lock", "not json");
    acquireInstanceLock(db).release();
    writeFileSync(db + ".lock", JSON.stringify({ pid: process.ppid, host: hostname(), at: 1 }));
    expect(() => acquireInstanceLock(db)).toThrow(/already using/);
    expect(JSON.parse(readFileSync(db + ".lock", "utf8")).pid).toBe(process.ppid);
  });

  it("a lock written by another host is never judged stale", () => {
    const db = join(tmp(), "q.db");
    writeFileSync(db + ".lock", JSON.stringify({ pid: 2 ** 22 + 1, host: "some-other-host-" + hostname(), at: 1 }));
    expect(() => acquireInstanceLock(db)).toThrow(/already using/);
  });

  it("does not release a lock it no longer owns", () => {
    const db = join(tmp(), "q.db");
    const l = acquireInstanceLock(db);
    writeFileSync(db + ".lock", JSON.stringify({ pid: process.ppid, host: hostname(), at: 1 }));
    l.release();
    expect(existsSync(db + ".lock")).toBe(true);
  });

  it("in-memory databases need no lock", () => {
    acquireInstanceLock(":memory:").release();
    acquireInstanceLock(":memory:").release();
  });
});
