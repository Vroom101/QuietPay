import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFilesAtomic } from "../src/atomic.js";

describe("writeFilesAtomic", () => {
  it("writes both files and leaves no temp files", () => {
    const d = mkdtempSync(join(tmpdir(), "qp-atomic-"));
    const out = join(d, "sub", "ledger.csv");
    writeFilesAtomic([{ path: out, data: "a,b\n" }, { path: `${out}.meta.json`, data: "{}\n" }]);
    expect(readFileSync(out, "utf8")).toBe("a,b\n");
    expect(readFileSync(`${out}.meta.json`, "utf8")).toBe("{}\n");
    expect(readdirSync(join(d, "sub")).sort()).toEqual(["ledger.csv", "ledger.csv.meta.json"]);
  });

  it("keeps the old file when a write fails", () => {
    const d = mkdtempSync(join(tmpdir(), "qp-atomic-"));
    const out = join(d, "ledger.csv");
    writeFileSync(out, "old");
    // The second target's parent is a regular file, so writing it fails before any rename happens.
    expect(() => writeFilesAtomic([{ path: out, data: "new" }, { path: join(out, "x", "meta.json"), data: "{}" }])).toThrow();
    expect(readFileSync(out, "utf8")).toBe("old");
    expect(readdirSync(d)).toEqual(["ledger.csv"]);
  });
});
