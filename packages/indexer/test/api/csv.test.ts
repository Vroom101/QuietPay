import { describe, it, expect } from "vitest";
import { readCsv, writeCsv } from "../../src/api/csv.js";
import { formatAmount, buildLedger } from "../../src/api/ledger.js";
import { makeEnv } from "./helpers.js";
describe("exact CSV accounting", () => {
  it("preserves six decimal places, negative values and integers beyond floating-point precision", () => {
    expect(formatAmount(1n)).toBe("0.000001");
    expect(formatAmount(-50000n)).toBe("-0.050000");
    expect(formatAmount(9007199254740993123456n)).toBe(
      "9007199254740993.123456",
    );
  });
  it("round-trips quoted commas, newlines and embedded quotes", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.indexer.sync();
    const rows = buildLedger(e.db.events()).entries;
    rows[0]!.status = 'a,"b"\nc';
    expect(readCsv(writeCsv(rows))).toEqual(rows);
    e.db.close();
  });
  it("accepts an empty export and rejects malformed quoting or column counts", () => {
    expect(readCsv(writeCsv([]))).toEqual([]);
    expect(() => readCsv('"unclosed')).toThrow("Unclosed");
    expect(() => readCsv(writeCsv([]) + "bad\n")).toThrow("Invalid CSV row");
  });
});
