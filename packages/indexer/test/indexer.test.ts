import { describe, expect, it } from "vitest";
import { IndexerDb, buildExport, eventSetHash, indexOnce, rebuild } from "../src/index.js";
import { FakeChain, PAYER, PAYTO, ROUTER, cfg, order, paidLog, refundedLog, transferLog, txHash } from "./fake.js";

const noSleep = async () => undefined;

function setup(headBlock = 400) {
  const chain = new FakeChain(headBlock);
  const db = new IndexerDb(":memory:");
  return { chain, db, config: cfg(), run: () => indexOnce({ db, src: chain, cfg: cfg(), sleep: noSleep }) };
}

function seed(chain: FakeChain) {
  chain.add(
    paidLog({ block: 150, orderId: order(1), value: 25_000_000n, fee: 50_000n }),
    refundedLog({ block: 160, orderId: order(1), amount: 5_000_000n, total: 5_000_000n, index: 0 }),
    paidLog({ block: 170, orderId: order(2), value: 1_000_000n, fee: 0n }),
    transferLog({ block: 180, from: PAYER, to: PAYTO, value: 1_500_000n }),
    refundedLog({ block: 190, orderId: order(1), amount: 2_000_000n, total: 7_000_000n, index: 1 }),
  );
}

describe("indexing", () => {
  it("6. running index twice produces no duplicate rows", async () => {
    const { chain, db, run } = setup();
    seed(chain);
    const first = await run();
    const rowsAfterFirst = db.ledger();
    const eventsAfterFirst = db.events().length;
    const second = await run();
    expect(first.newEvents).toBe(5);
    expect(second.newEvents).toBe(0);
    expect(db.ledger()).toEqual(rowsAfterFirst);
    expect(db.events()).toHaveLength(eventsAfterFirst);
    expect(rowsAfterFirst.map((r) => r.source)).toEqual(["router", "router", "payto_transfer"]);
  });

  it("re-reading the same block range inserts nothing new (keyed by tx_hash, log_index)", async () => {
    const { chain, db, run } = setup();
    seed(chain);
    await run();
    const before = db.events();
    // Force a re-scan from the deploy block.
    db.raw.prepare("DELETE FROM state").run();
    await run();
    expect(db.events()).toEqual(before);
  });

  it("7. rebuild from raw events gives rows identical to the incremental run", async () => {
    const { chain, db, run, config } = setup(300);
    seed(chain);
    await run(); // finalized = 288
    // More activity arrives later, so the ledger is built across several incremental runs.
    chain.add(paidLog({ block: 292, orderId: order(3), value: 9_000_000n, fee: 0n }));
    chain.add(refundedLog({ block: 295, orderId: order(3), amount: 9_000_000n, total: 9_000_000n, index: 0 }));
    chain.head = 320;
    await run();
    const incremental = db.ledger();
    expect(incremental.length).toBeGreaterThan(3);
    const rebuilt = rebuild(db, config);
    expect(db.ledger()).toEqual(incremental);
    expect(rebuilt.map((r) => r.key).sort()).toEqual(incremental.map((r) => r.key).sort());
    // And a rebuild after wiping the derived table still matches.
    db.clearLedger();
    rebuild(db, config);
    expect(db.ledger()).toEqual(incremental);
  });

  it("8. a reorg inside the unfinalized window changes nothing in the finalized ledger, and rows are right after re-read", async () => {
    const { chain, db, run } = setup(300); // finalized = 288
    seed(chain);
    // A payment in the unfinalized window (block 295 > 288), which will be reorged away.
    const ghost = paidLog({ block: 295, orderId: order(9), value: 3_000_000n, fee: 0n });
    chain.add(ghost);
    await run();
    const finalizedRows = db.ledger();
    expect(finalizedRows.some((r) => r.orderId === order(9))).toBe(false); // not stored: not final yet
    expect(db.getCursor()!.block).toBe(288);

    // Reorg: the ghost payment disappears, a different one lands in its place, hashes change above the cursor.
    chain.logs = chain.logs.filter((l) => l !== ghost);
    chain.add(paidLog({ block: 296, orderId: order(10), value: 4_000_000n, fee: 0n }));
    chain.fork = 1;
    chain.forkAbove = 288; // the reorg is confined to the unfinalized window
    await run();
    expect(db.ledger().filter((r) => finalizedRows.some((f) => f.key === r.key))).toEqual(finalizedRows); // finalized part untouched
    expect(db.ledger().some((r) => r.orderId === order(9))).toBe(false); // the reorged-out payment never appears

    // Chain advances; block 296 is now final and is read correctly.
    chain.head = 320;
    await run();
    const keys = db.ledger().map((r) => r.orderId);
    expect(keys).toContain(order(10));
    expect(keys).not.toContain(order(9));
  });

  it("stops instead of guessing when a reorg is deeper than the confirmation depth", async () => {
    const { chain, run } = setup(300);
    seed(chain);
    await run();
    chain.fork = 1; // every block hash changes, including the stored cursor block
    chain.head = 330;
    await expect(run()).rejects.toThrow(/reorg deeper/);
  });

  it("only stores blocks up to head - confirmations", async () => {
    const { chain, db, run } = setup(195); // finalized = 183: the refund at block 190 is not final
    seed(chain);
    await run();
    expect(db.getCursor()!.block).toBe(183);
    expect(db.events().every((e) => e.block <= 183)).toBe(true);
    expect(db.ledger().find((r) => r.orderId === order(1))!.refundedUsdt).toBe("5.000000");
    chain.head = 210;
    await run();
    expect(db.ledger().find((r) => r.orderId === order(1))!.refundedUsdt).toBe("7.000000");
  });
});

describe("export", () => {
  it("9. two exports of the same range are byte-for-byte identical and the eventSetHash matches", async () => {
    const { chain, db, run, config } = setup();
    seed(chain);
    await run();
    const a = buildExport(db, config, { from: 100, to: 300, generatedAt: "2026-11-06T00:00:00.000Z" });
    const b = buildExport(db, config, { from: 100, to: 300, generatedAt: "2026-11-06T00:00:00.000Z" });
    expect(Buffer.from(a.csv)).toEqual(Buffer.from(b.csv));
    expect(JSON.stringify(a.meta)).toBe(JSON.stringify(b.meta));
    expect(a.meta.eventSetHash).toBe(b.meta.eventSetHash);
    expect(a.meta.eventSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.meta).toMatchObject({ fromBlock: 100, toBlock: 300, confirmations: 12 });

    // Same hash from a different database filled by a fresh index run, and after a rebuild.
    const other = setup();
    seed(other.chain);
    other.chain.logs = [...chain.logs];
    await other.run();
    rebuild(other.db, config);
    expect(buildExport(other.db, config, { from: 100, to: 300 }).csv).toBe(a.csv);
    expect(buildExport(other.db, config, { from: 100, to: 300 }).meta.eventSetHash).toBe(a.meta.eventSetHash);
  });

  it("eventSetHash is the SHA-256 of the sorted tx_hash:log_index lines", () => {
    const evs = [
      { txHash: "0xbb", logIndex: 1 },
      { txHash: "0xaa", logIndex: 2 },
    ];
    expect(eventSetHash(evs)).toBe(eventSetHash([...evs].reverse()));
    expect(eventSetHash(evs)).not.toBe(eventSetHash([evs[0]!]));
  });

  it("12. an export never includes blocks above the finalized head", async () => {
    const { chain, db, run, config } = setup(195); // finalized = 183
    seed(chain);
    await run();
    const res = buildExport(db, config, { from: 100, to: 10_000 });
    expect(res.meta.toBlock).toBe(183);
    expect(res.rows.every((r) => r.block <= 183)).toBe(true);
    const asOf = res.rows.find((r) => r.orderId === order(1))!;
    expect(asOf.refundedUsdt).toBe("5.000000"); // the block-190 refund is not final, so it is not applied
  });

  it("filters rows to the requested range but applies refunds up to the range end", async () => {
    const { chain, db, run, config } = setup();
    seed(chain);
    await run();
    const res = buildExport(db, config, { from: 165, to: 300 });
    expect(res.rows.map((r) => r.block)).toEqual([170, 180]); // the block-150 order is outside the range
    expect(buildExport(db, config, { from: 100, to: 175 }).rows.find((r) => r.orderId === order(1))!.refundedUsdt).toBe("5.000000");
  });
});

describe("paging and rpc errors", () => {
  it("10. a 5,500 block range is read in pages of at most 1,000, and -32062 halves the page", async () => {
    const chain = new FakeChain(6000);
    const db = new IndexerDb(":memory:");
    const requests: [number, number][] = [];
    chain.add(paidLog({ block: 3000, orderId: order(1), value: 1_000_000n, fee: 0n }));
    const config = cfg({ deployBlock: 100, confirmations: 0, facilitatorPayTo: undefined });
    await indexOnce({ db, src: chain, cfg: { ...config }, sleep: noSleep, onRequest: (f, t) => requests.push([f, t]) });
    expect(requests[0]![0]).toBe(100);
    expect(requests.at(-1)![1]).toBe(6000);
    expect(Math.max(...requests.map(([f, t]) => t - f + 1))).toBeLessThanOrEqual(1000);
    expect(requests.length).toBeGreaterThanOrEqual(6); // 5,901 blocks / 1,000 per page
    expect(db.ledger()).toHaveLength(1);

    // Now an endpoint that only accepts 300 blocks: the page halves 1000 -> 500 -> 250 and the run still succeeds.
    const strict = new FakeChain(6000);
    strict.maxRange = 300;
    strict.add(paidLog({ block: 3000, orderId: order(1), value: 1_000_000n, fee: 0n }));
    const db2 = new IndexerDb(":memory:");
    const reqs2: [number, number][] = [];
    await indexOnce({ db: db2, src: strict, cfg: { ...config }, sleep: noSleep, onRequest: (f, t) => reqs2.push([f, t]) });
    expect(strict.errors).toBe(2); // 1000 and 500 were rejected, then 250 worked
    expect(reqs2.slice(0, 3).map(([f, t]) => t - f + 1)).toEqual([1000, 500, 250]);
    expect(Math.max(...reqs2.slice(3).map(([f, t]) => t - f + 1))).toBeLessThanOrEqual(250);
    expect(db2.ledger()).toHaveLength(1);
    expect(db2.getCursor()!.block).toBe(6000);
  });

  it("backs off on rate limits and retries", async () => {
    const chain = new FakeChain(500);
    chain.add(paidLog({ block: 200, orderId: order(1), value: 1n, fee: 0n }));
    let failures = 2;
    const real = chain.getLogs.bind(chain);
    chain.getLogs = async (q) => {
      if (failures-- > 0) throw Object.assign(new Error("429 Too Many Requests"), { code: 429 });
      return real(q);
    };
    const sleeps: number[] = [];
    const db = new IndexerDb(":memory:");
    await indexOnce({ db, src: chain, cfg: cfg({ confirmations: 0, facilitatorPayTo: undefined }), sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([500, 1000]);
    expect(db.ledger()).toHaveLength(1);
  });

  it("does not swallow unexpected errors", async () => {
    const chain = new FakeChain(500);
    chain.getLogs = async () => {
      throw new Error("boom");
    };
    await expect(indexOnce({ db: new IndexerDb(":memory:"), src: chain, cfg: cfg({ confirmations: 0 }), sleep: noSleep })).rejects.toThrow("boom");
  });
});

void ROUTER;
void txHash;
