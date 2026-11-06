import { describe, it, expect } from "vitest";
import { verifyExport } from "../src/verifier.js";
import { readCsv, writeCsv } from "../src/csv.js";
import { makeEnv, scope, MERCHANT, OTHER, hash, address } from "./helpers.js";
async function setup() {
  const e = makeEnv();
  await e.chain.paid();
  await e.chain.refund();
  const bundle = await e.indexer.export({ merchantId: MERCHANT });
  e.db.close();
  return { ...e, bundle };
}
describe("independent export verifier", () => {
  it("passes a clean export after the index database is closed", async () => {
    const e = await setup(),
      r = await verifyExport(e.chain, scope, e.bundle, {
        merchantId: MERCHANT,
      });
    expect(r.ok).toBe(true);
    expect(r.counts).toEqual({
      matched: 2,
      altered: 0,
      missing: 0,
      extra: 0,
      duplicates: 0,
    });
    expect(r.checkpoint.eventCount).toBe(2);
    expect(e.chain.pages.every((p) => p.to - p.from < 1000)).toBe(true);
  });
  it("reports the exact altered field", async () => {
    const e = await setup(),
      rows = readCsv(e.bundle.csv);
    rows[0]!.gross_usdt = "26.000000";
    const r = await verifyExport(e.chain, scope, {
      ...e.bundle,
      csv: writeCsv(rows),
    });
    expect(r.ok).toBe(false);
    expect(r.counts).toMatchObject({ altered: 1, missing: 0, extra: 0 });
    expect(r.altered[0]?.fields).toEqual([
      { field: "gross_usdt", expected: "25.000000", actual: "26.000000" },
    ]);
  });
  it("reports deleted, fabricated and duplicated rows separately", async () => {
    const e = await setup(),
      rows = readCsv(e.bundle.csv);
    const missing = await verifyExport(e.chain, scope, {
      ...e.bundle,
      csv: writeCsv(rows.slice(1)),
    });
    expect(missing.counts.missing).toBe(1);
    const extra = await verifyExport(e.chain, scope, {
      ...e.bundle,
      csv: writeCsv([...rows, { ...rows[0]!, tx_hash: hash(999) }]),
    });
    expect(extra.counts.extra).toBe(1);
    const duplicate = await verifyExport(e.chain, scope, {
      ...e.bundle,
      csv: writeCsv([...rows, rows[0]!]),
    });
    expect(duplicate.counts.duplicates).toBe(1);
    expect(duplicate.ok).toBe(false);
  });
  it("does not let an unchanged first copy hide an altered duplicate", async () => {
    const e = await setup(),
      rows = readCsv(e.bundle.csv);
    const r = await verifyExport(e.chain, scope, {
      ...e.bundle,
      csv: writeCsv([...rows, { ...rows[0]!, net_usdt: "999.000000" }]),
    });
    expect(r.counts).toMatchObject({ duplicates: 1, altered: 1 });
    expect(r.ok).toBe(false);
  });
  it("flags metadata hashes that do not match the independently scanned chain", async () => {
    const e = await setup();
    const r = await verifyExport(e.chain, scope, {
      ...e.bundle,
      meta: {
        ...e.bundle.meta,
        eventSetHash: hash(123),
        toBlockHash: hash(456),
      },
    });
    expect(r.eventSetHashMatches).toBe(false);
    expect(r.toBlockHashMatches).toBe(false);
    expect(r.ok).toBe(false);
  });
  it("pins trusted contracts, confirmation policy, merchant and agreed range", async () => {
    const e = await setup();
    await expect(
      verifyExport(e.chain, scope, {
        ...e.bundle,
        meta: { ...e.bundle.meta, router: address(99) },
      }),
    ).rejects.toThrow("independently configured");
    await expect(
      verifyExport(e.chain, scope, {
        ...e.bundle,
        meta: { ...e.bundle.meta, confirmations: 1 },
      }),
    ).rejects.toThrow("confirmation policy");
    await expect(
      verifyExport(e.chain, scope, e.bundle, { merchantId: OTHER }),
    ).rejects.toThrow("merchant");
    await expect(
      verifyExport(e.chain, scope, e.bundle, { fromBlock: 2 }),
    ).rejects.toThrow("expected range");
  });
  it("refuses unconfirmed ranges and malformed CSV", async () => {
    const e = await setup();
    e.chain.head = 10;
    await expect(verifyExport(e.chain, scope, e.bundle)).rejects.toThrow(
      "unconfirmed",
    );
    e.chain.head = 12;
    await expect(
      verifyExport(e.chain, scope, { ...e.bundle, csv: "wrong,columns\n" }),
    ).rejects.toThrow("CSV columns");
  });
  it("verifies a refund-only range and excludes other merchants", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.chain.paid(3, OTHER, hash(999));
    await e.chain.refund();
    const bundle = await e.indexer.export({
      fromBlock: 4,
      toBlock: 4,
      merchantId: MERCHANT,
    });
    e.db.close();
    const r = await verifyExport(e.chain, scope, bundle);
    expect(r.ok).toBe(true);
    expect(r.counts.matched).toBe(1);
  });
});
