import { describe, it, expect } from "vitest";
import { IndexDb } from "../src/db.js";
import { Indexer } from "../src/indexer.js";
import { buildLedger } from "../src/ledger.js";
import { readCsv } from "../src/csv.js";
import {
  makeEnv,
  scope,
  MERCHANT,
  OTHER,
  ORDER,
  hash,
  address,
} from "./helpers.js";

describe("persisted event indexer", () => {
  it("indexes only confirmed blocks and pages across a 1,000-block boundary without gaps", async () => {
    const e = makeEnv(1000);
    e.chain.head = 2005;
    await e.chain.paid(1000);
    await e.chain.paid(1001, OTHER, hash(202));
    await e.chain.paid(2004, MERCHANT, hash(203));
    await e.indexer.sync();
    expect(e.db.cursor).toBe(2003);
    expect(e.chain.pages).toEqual([
      { from: 1, to: 1000 },
      { from: 1001, to: 2000 },
      { from: 2001, to: 2003 },
    ]);
    expect(e.db.events()).toHaveLength(2);
    e.chain.head++;
    await e.indexer.sync();
    expect(e.db.events()).toHaveLength(3);
    e.db.close();
  });
  it("deduplicates logs and produces the same checkpoint after rebuilding a deleted database", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.chain.refund();
    e.chain.duplicate = true;
    await Promise.all([e.indexer.sync(), e.indexer.sync()]);
    expect(e.db.events()).toHaveLength(2);
    const first = await e.indexer.export({ merchantId: MERCHANT });
    const otherDb = new IndexDb(":memory:", scope),
      other = new Indexer(otherDb, e.chain, scope, 2);
    const second = await other.export({ merchantId: MERCHANT });
    expect(second.csv).toBe(first.csv);
    expect(second.meta.eventSetHash).toBe(first.meta.eventSetHash);
    e.db.close();
    otherDb.close();
  });
  it("reopens persisted state and resumes without fetching prior pages", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.indexer.sync();
    const reopened = new IndexDb(e.db.raw.serialize(), scope),
      next = new Indexer(reopened, e.chain, scope, 3);
    e.chain.pages = [];
    e.chain.head = 15;
    await next.sync();
    expect(e.chain.pages[0]?.from).toBe(11);
    expect(reopened.events()).toHaveLength(1);
    e.db.close();
    reopened.close();
  });
  it("rolls back orphaned refunds and replaces them with the new canonical history", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.chain.refund();
    await e.indexer.sync();
    expect(buildLedger(e.db.events()).orders[0]?.refunded).toBe("5.000000");
    await e.chain.reorg(4);
    await e.chain.refund(5, "1000000");
    await e.indexer.sync();
    expect(buildLedger(e.db.events()).orders[0]?.refunded).toBe("1.000000");
    expect(e.db.events().some((r) => r.event.blockNumber === 4)).toBe(false);
    e.db.close();
  });
  it("handles a deep reorg and a shorter chain safely", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.indexer.sync();
    await e.chain.reorg(1);
    e.chain.head = 5;
    await e.chain.paid(3);
    await e.indexer.sync();
    expect(e.db.cursor).toBe(3);
    expect(e.db.events()).toHaveLength(1);
    expect(e.db.events()[0]?.event.blockNumber).toBe(3);
    e.db.close();
  });
  it("does not advance the cursor past an RPC failure and resumes from the failed page", async () => {
    const e = makeEnv();
    await e.chain.paid();
    e.chain.failAt = 4;
    await expect(e.indexer.sync()).rejects.toThrow("RPC unavailable");
    expect(e.db.cursor).toBe(3);
    expect(e.indexer.lastError).toContain("RPC unavailable");
    e.chain.failAt = undefined;
    await e.indexer.sync();
    expect(e.db.cursor).toBe(10);
    expect(e.indexer.lastError).toBeNull();
    e.db.close();
  });
  it("bounds work per sync and refuses exports beyond the indexed cursor", async () => {
    const e = makeEnv(2, 1);
    await e.chain.paid();
    await e.indexer.sync();
    expect(e.db.cursor).toBe(2);
    await expect(e.indexer.export({ toBlock: 10 })).rejects.toThrow(
      "not fully indexed",
    );
    e.db.close();
  });
  it("keeps refund-only export ranges complete using earlier payment context", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.chain.refund();
    const bundle = await e.indexer.export({
      fromBlock: 4,
      toBlock: 4,
      merchantId: MERCHANT,
    });
    const rows = readCsv(bundle.csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gross_usdt: "0.000000",
      refunded_usdt: "5.000000",
      net_usdt: "-5.000000",
      status: "partially_refunded",
    });
    e.db.close();
  });
  it("keeps full refunds in payer accounting and shows the merchant's sponsored fee as negative net", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.chain.refund(4, "25000000");
    const ledger = await e.indexer.ledger(MERCHANT);
    expect(ledger.orders[0]).toMatchObject({
      gross: "25.000000",
      fee: "0.050000",
      refunded: "25.000000",
      net: "-0.050000",
      status: "refunded",
      refundCount: 1,
    });
    expect(ledger.totals.net).toBe("-0.050000");
    e.db.close();
  });
  it("refuses wrong networks, mismatched database scope and invalid page sizes", async () => {
    const e = makeEnv();
    e.chain.chainId = 1;
    await expect(e.indexer.sync()).rejects.toThrow("chain ID");
    expect(
      () =>
        new IndexDb(e.db.raw.serialize(), { ...scope, router: address(99) }),
    ).toThrow("different");
    expect(() => new Indexer(e.db, e.chain, scope, 1001)).toThrow("Page size");
    e.db.close();
  });
  it("never commits a log whose hash disagrees with its block", async () => {
    const e = makeEnv();
    const paid = await e.chain.paid();
    paid.blockHash = hash(999999);
    await expect(e.indexer.sync()).rejects.toThrow("canonical block");
    expect(e.db.cursor).toBe(0);
    e.db.close();
  });
  it("removes formerly confirmed data when the confirmation policy increases", async () => {
    const e = makeEnv();
    await e.chain.paid();
    await e.chain.refund(8);
    await e.indexer.sync();
    const stricter = { ...scope, confirmations: 5 };
    const db = new IndexDb(e.db.raw.serialize(), stricter),
      indexer = new Indexer(db, e.chain, stricter, 3);
    await indexer.sync();
    expect(db.cursor).toBe(7);
    expect(db.events()).toHaveLength(1);
    expect((await indexer.ledger(MERCHANT)).orders[0]?.refunded).toBe(
      "0.000000",
    );
    db.close();
    e.db.close();
  });
  it("rejects conflicting duplicates without partially committing a page", async () => {
    const e = makeEnv();
    const event = await e.chain.paid();
    e.chain.events.push({ ...event, value: "26000000" });
    await expect(e.indexer.sync()).rejects.toThrow("Conflicting log");
    expect(e.db.cursor).toBe(0);
    e.db.close();
  });
  it("retries a page if the chain reorganizes during its RPC reads", async () => {
    const e = makeEnv();
    await e.chain.paid();
    const getEvents = e.chain.getEvents.bind(e.chain);
    let changed = false;
    e.chain.getEvents = async (from, to) => {
      const rows = await getEvents(from, to);
      if (!changed) {
        changed = true;
        await e.chain.reorg(1);
      }
      return rows;
    };
    await expect(e.indexer.sync()).rejects.toThrow("Chain changed");
    expect(e.db.cursor).toBe(0);
    await e.indexer.sync();
    expect(e.db.cursor).toBe(10);
    expect(e.db.events()).toHaveLength(0);
    e.db.close();
  });
});
