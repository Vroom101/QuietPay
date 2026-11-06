import { describe, expect, it } from "vitest";
import { ConfigError, QUALIFYING_USDT, getQualifyingDeployment } from "@quietpay/shared";
import { verifyLedger, type VerifyReport } from "../src/index.js";
import { FakeChain, PAYER, PAYTO, ROUTER, USDT, exportWithIndexer, payment, scenario, transfer, tx, order } from "./fake.js";

const COLS = ["date_utc", "source", "order_id", "merchant_id", "payer", "gross_usdt", "relay_fee_usdt", "refunded_usdt", "net_usdt", "status", "tx_hash", "block", "log_index"];

/** Replaces one cell of data row `row` (1-based, header excluded). */
function setCell(csv: string, row: number, col: string, value: string): string {
  const lines = csv.split("\n");
  const cells = lines[row]!.split(",");
  cells[COLS.indexOf(col)] = value;
  lines[row] = cells.join(",");
  return lines.join("\n");
}
const cell = (csv: string, row: number, col: string) => csv.split("\n")[row]!.split(",")[COLS.indexOf(col)]!;
const codes = (r: VerifyReport) => r.issues.map((i) => i.code);

async function run(csv: string, metaText: string, chain: FakeChain, over: Partial<Parameters<typeof verifyLedger>[0]> = {}) {
  return verifyLedger({ csvText: csv, metaText, src: chain, router: ROUTER, usdt: USDT, payTo: PAYTO, sleep: async () => undefined, ...over });
}

async function valid() {
  const chain = scenario();
  const exp = await exportWithIndexer(chain);
  return { chain, ...exp };
}

describe("a correct export", () => {
  it("passes every check and recomputes the same rows and hash", async () => {
    const { chain, csv, metaText, meta } = await valid();
    expect(csv.trimEnd().split("\n")).toHaveLength(5); // header + 4 rows (double-count row excluded)
    const r = await run(csv, metaText, chain);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual({ structure: "pass", sidecar: "pass", finality: "pass", rows: "pass", event_set_hash: "pass", invariants: "pass", timestamps: "pass" });
    expect(r.eventSetHash).toEqual({ sidecar: meta.eventSetHash, recomputed: meta.eventSetHash });
    expect(r.rowsInCsv).toBe(4);
    expect(r.rowsExpected).toBe(4);
    expect(r.finalizedBlock).toBe(388);
  });

  it("pages eth_getLogs at <= 1000 blocks and halves on -32062", async () => {
    const chain = scenario(3000);
    const { csv, metaText } = await exportWithIndexer(chain);
    chain.maxRange = 300;
    const r = await run(csv, metaText, chain);
    expect(r.ok).toBe(true);
    expect(Math.max(...chain.requests.map(([a, b]) => b - a + 1))).toBeLessThanOrEqual(1000);
    expect(chain.requests.some(([a, b]) => b - a + 1 === 1000)).toBe(true); // tried a full page first
  });

  it("passes for a sub-range export (refunds applied up to toBlock)", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain, { from: 150, to: 185 }); // second refund (190) not applied
    expect(cell(csv, 1, "refunded_usdt")).toBe("5.000000");
    const r = await run(csv, metaText, chain);
    expect(r.issues).toEqual([]);
  });

  it("passes for an export made without a pay-to address when none is given", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain, { payTo: null });
    const r = await run(csv, metaText, chain, { payTo: undefined });
    expect(r.issues).toEqual([]);
  });
});

describe("tampered cells are caught with a specific reason", () => {
  const cases: [string, string, string][] = [
    ["date_utc", "2027-01-01T00:00:00.000Z", "wrong_date"],
    ["source", "payto_transfer", "wrong_field"],
    ["order_id", order(99), "wrong_field"],
    ["merchant_id", "0x" + "02".repeat(32), "wrong_field"],
    ["payer", "0x9999999999999999999999999999999999999999", "wrong_field"],
    ["gross_usdt", "26.000000", "wrong_amount"],
    ["relay_fee_usdt", "0.040000", "wrong_amount"],
    ["refunded_usdt", "6.000000", "wrong_refunded"],
    ["net_usdt", "18.000000", "wrong_amount"],
    ["status", "refunded", "wrong_status"],
    ["tx_hash", tx(0xdead), "wrong_tx_hash"],
    ["block", "151", "wrong_block"],
    ["log_index", "2", "wrong_log_index"],
  ];
  for (const [col, value, code] of cases) {
    it(`${col} -> ${code}`, async () => {
      const { chain, csv, metaText } = await valid();
      const bad = setCell(csv, 1, col, value);
      const r = await run(bad, metaText, chain);
      expect(r.ok).toBe(false);
      expect(codes(r)).toContain(code);
      const issue = r.issues.find((i) => i.code === code)!;
      expect(issue.message.length).toBeGreaterThan(10);
      if (code === "wrong_amount" || code === "wrong_field") expect(issue.field).toBe(col);
      expect(codes(r)).not.toContain("missing_row");
      expect(codes(r)).not.toContain("extra_row");
    });
  }

  it("a tampered gross also breaks the chain invariant gross == Paid.value", async () => {
    const { chain, csv, metaText } = await valid();
    const r = await run(setCell(csv, 1, "gross_usdt", "26.000000"), metaText, chain);
    expect(codes(r)).toContain("invariant_gross");
    expect(r.checks.invariants).toBe("fail");
  });

  it("a tampered payto deposit amount is caught", async () => {
    const { chain, csv, metaText } = await valid();
    expect(cell(csv, 3, "source")).toBe("payto_transfer");
    const r = await run(setCell(setCell(csv, 3, "gross_usdt", "1.600000"), 3, "net_usdt", "1.600000"), metaText, chain);
    expect(r.issues.filter((i) => i.code === "wrong_amount").map((i) => i.field).sort()).toEqual(["gross_usdt", "net_usdt"]);
  });
});

describe("rows added, removed or reordered", () => {
  it("a deleted row is reported missing", async () => {
    const { chain, csv, metaText } = await valid();
    const lines = csv.split("\n");
    lines.splice(2, 1);
    const r = await run(lines.join("\n"), metaText, chain);
    expect(codes(r)).toEqual(["missing_row"]);
    expect(r.issues[0]!.key).toBe(`${tx(3)}:2`);
  });

  it("an added row is reported extra", async () => {
    const { chain, csv, metaText } = await valid();
    const lines = csv.split("\n");
    const fake = lines[3]!.split(",");
    fake[10] = tx(0xbeef);
    fake[11] = "185";
    fake[0] = new Date((1_800_000_000 + 185 * 2) * 1000).toISOString();
    lines.splice(4, 0, fake.join(","));
    const r = await run(lines.join("\n"), metaText, chain);
    expect(codes(r)).toEqual(["extra_row"]);
    expect(r.issues[0]!.line).toBe(5);
  });

  it("swapped rows break the sort order", async () => {
    const { chain, csv, metaText } = await valid();
    const lines = csv.split("\n");
    [lines[1], lines[2]] = [lines[2]!, lines[1]!];
    const r = await run(lines.join("\n"), metaText, chain);
    expect(codes(r)).toEqual(["not_sorted"]);
    expect(r.checks.structure).toBe("fail");
  });

  it("a duplicated row is reported", async () => {
    const { chain, csv, metaText } = await valid();
    const lines = csv.split("\n");
    lines.splice(2, 0, lines[1]!);
    const r = await run(lines.join("\n"), metaText, chain);
    expect(codes(r)).toContain("duplicate_row");
  });

  it("a row outside [fromBlock, toBlock] is reported", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain, { from: 150, to: 175 });
    const full = await exportWithIndexer(chain);
    const extra = full.csv.split("\n")[3]!; // the block-180 deposit
    const r = await run(csv + extra + "\n", metaText, chain);
    expect(codes(r)).toContain("row_out_of_range");
  });
});

describe("format", () => {
  it("CRLF line endings fail", async () => {
    const { chain, csv, metaText } = await valid();
    const r = await run(csv.replace(/\n/g, "\r\n"), metaText, chain);
    expect(codes(r)).toContain("crlf_line_endings");
    expect(r.ok).toBe(false);
  });

  it("a 7-decimal amount fails", async () => {
    const { chain, csv, metaText } = await valid();
    const r = await run(setCell(csv, 2, "gross_usdt", "1.0000000"), metaText, chain);
    expect(codes(r)).toContain("bad_amount");
    expect(r.issues.find((i) => i.code === "bad_amount")).toMatchObject({ line: 3, field: "gross_usdt" });
  });

  it("columns out of order fail", async () => {
    const { chain, csv, metaText } = await valid();
    const r = await run(csv.replace("gross_usdt,relay_fee_usdt", "relay_fee_usdt,gross_usdt"), metaText, chain);
    expect(codes(r)).toContain("bad_header");
  });

  it("a missing trailing newline fails", async () => {
    const { chain, csv, metaText } = await valid();
    const r = await run(csv.trimEnd(), metaText, chain);
    expect(codes(r)).toContain("missing_trailing_newline");
  });

  it("a row with the wrong number of cells fails", async () => {
    const { chain, csv, metaText } = await valid();
    const r = await run(csv.replace(",partially_refunded,", ",partially_refunded,extra,"), metaText, chain);
    expect(codes(r)).toContain("bad_cell_count");
  });

  it("a bad block number fails", async () => {
    const { chain, csv, metaText } = await valid();
    const r = await run(setCell(csv, 1, "block", "15a"), metaText, chain);
    expect(codes(r)).toContain("bad_integer");
  });
});

describe("sidecar and finality", () => {
  it("a wrong sidecar eventSetHash fails", async () => {
    const { chain, csv, meta } = await valid();
    const bad = JSON.stringify({ ...meta, eventSetHash: "0".repeat(64) });
    const r = await run(csv, bad, chain);
    expect(codes(r)).toEqual(["event_set_hash_mismatch"]);
    expect(r.checks.event_set_hash).toBe("fail");
  });

  it("a hidden event in range changes the recomputed hash", async () => {
    const { chain, csv, metaText } = await valid();
    chain.add(transfer(210, tx(0x77), 0, ROUTER, PAYTO, 1n)); // from the router: excluded from rows but hashed
    const r = await run(csv, metaText, chain);
    expect(codes(r)).toEqual(["event_set_hash_mismatch"]);
  });

  it("a toBlock beyond the finalized block is refused before any log is read", async () => {
    const { chain, csv, meta } = await valid();
    const r = await run(csv, JSON.stringify({ ...meta, toBlock: 395 }), chain); // head 400 - 12 = 388
    expect(codes(r)).toEqual(["to_block_not_final"]);
    expect(r.ok).toBe(false);
    expect(chain.requests).toEqual([]);
    expect(r.checks.rows).toBe("skipped");
  });

  it("a malformed sidecar fails", async () => {
    const { chain, csv } = await valid();
    expect(codes(await run(csv, "{not json", chain))).toEqual(["bad_sidecar"]);
    expect(codes(await run(csv, JSON.stringify({ fromBlock: 10, toBlock: 5, confirmations: 12, eventSetHash: "a".repeat(64) }), chain))).toEqual(["bad_sidecar"]);
  });

  it("verifying without the pay-to address the export used is reported", async () => {
    const { chain, csv, metaText } = await valid();
    const r = await run(csv, metaText, chain, { payTo: undefined });
    expect(codes(r)).toContain("extra_row");
    expect(codes(r)).toContain("event_set_hash_mismatch");
  });
});

describe("chain invariants", () => {
  it("a payout transfer that does not match gross - fee is caught even though the rows agree", async () => {
    const chain = new FakeChain(400);
    chain.add(...payment({ block: 150, tx: tx(1), orderId: order(1), value: 25_000_000n, fee: 50_000n, payoutAmount: 24_000_000n }));
    const { csv, metaText } = await exportWithIndexer(chain);
    const r = await run(csv, metaText, chain);
    expect(r.checks.rows).toBe("pass");
    expect(codes(r)).toEqual(["transfer_mismatch"]);
    expect(r.issues[0]!.message).toMatch(/payout/);
  });

  it("a missing relayer fee transfer is caught", async () => {
    const chain = new FakeChain(400);
    chain.add(...payment({ block: 150, tx: tx(1), orderId: order(1), value: 25_000_000n, fee: 50_000n }).filter((l) => l.logIndex !== 2));
    const { csv, metaText } = await exportWithIndexer(chain);
    const r = await run(csv, metaText, chain);
    expect(codes(r)).toEqual(["transfer_mismatch"]);
    expect(r.issues[0]!.message).toMatch(/relayer/);
  });

  it("checks payer -> router pull of gross", async () => {
    const chain = new FakeChain(400);
    chain.add(...payment({ block: 150, tx: tx(1), orderId: order(1), value: 25_000_000n, fee: 0n }).filter((l) => l.logIndex !== 0));
    const { csv, metaText } = await exportWithIndexer(chain);
    const r = await run(csv, metaText, chain);
    expect(codes(r)).toEqual(["transfer_mismatch"]);
    expect(r.issues[0]!.message).toMatch(new RegExp(PAYER));
  });
});

describe("qualifying guard on chain 1874", () => {
  it("rejects a non-official token", async () => {
    const chain = new FakeChain(400, 1874);
    await expect(run("", "{}", chain)).rejects.toBeInstanceOf(ConfigError);
  });

  it("rejects a router other than the qualifying one", async () => {
    const chain = new FakeChain(400, 1874);
    await expect(run("", "{}", chain, { usdt: QUALIFYING_USDT })).rejects.toThrow(/router/i);
  });

  it("accepts the qualifying router and official USDT", async () => {
    const dep = getQualifyingDeployment();
    const chain = new FakeChain(dep.deployBlock + 100, 1874);
    const csv = COLS.join(",") + "\n";
    const meta = { fromBlock: dep.deployBlock, toBlock: dep.deployBlock + 50, confirmations: 12, eventSetHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", generatedAt: "x" };
    const r = await verifyLedger({ csvText: csv, metaText: JSON.stringify(meta), src: chain, router: dep.router, usdt: QUALIFYING_USDT });
    expect(r.issues).toEqual([]);
    expect(r.chainId).toBe(1874);
  });
});

describe("declared-range truncation (L4)", () => {
  it("fails when the sidecar range is narrower than the range the verifier was told to expect", async () => {
    const chain = scenario();
    const { meta, csv, metaText } = await valid();
    // attacker keeps only the first rows and shrinks toBlock in the sidecar so everything still self-matches
    const shrunk = await exportWithIndexer(chain, { from: meta.fromBlock, to: 120 });
    const r = await run(shrunk.csv, shrunk.metaText, chain, { expected: { fromBlock: meta.fromBlock, toBlock: meta.toBlock } });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("range_mismatch");
    // while the same shrunken file passes when no expectation is supplied (documents why --from/--to exists)
    const loose = await run(shrunk.csv, shrunk.metaText, chain);
    expect(loose.ok).toBe(true);
    expect(csv).not.toBe(shrunk.csv);
    expect(metaText).not.toBe(shrunk.metaText);
  });

  it("fails when only fromBlock moved, and when the sidecar range is wider", async () => {
    const chain = scenario();
    const { meta, csv, metaText } = await valid();
    const r1 = await run(csv, metaText, chain, { expected: { fromBlock: meta.fromBlock + 1, toBlock: meta.toBlock } });
    expect(codes(r1)).toContain("range_mismatch");
    const r2 = await run(csv, metaText, chain, { expected: { fromBlock: meta.fromBlock, toBlock: meta.toBlock - 1 } });
    expect(codes(r2)).toContain("range_mismatch");
  });

  it("passes with the matching expected range and prints the checkpoint", async () => {
    const chain = scenario();
    const { meta, csv, metaText } = await valid();
    const r = await run(csv, metaText, chain, { expected: { fromBlock: meta.fromBlock, toBlock: meta.toBlock } });
    expect(r.issues).toEqual([]);
    expect(r.checkpoint).toEqual({ fromBlock: meta.fromBlock, toBlock: meta.toBlock, eventCount: r.eventsInRange, eventSetHash: meta.eventSetHash });
  });

  it("fails when the export was made with fewer confirmations than the verifier requires", async () => {
    const chain = scenario();
    const { csv, metaText } = await valid();
    const r = await run(csv, metaText, chain, { expected: { minConfirmations: 1000 } });
    expect(codes(r)).toContain("confirmations_below_expected");
  });

  it("never says OK for an empty export over a range that has events", async () => {
    const chain = scenario();
    const { metaText, meta } = await valid();
    const emptyCsv = "date_utc,source,order_id,merchant_id,payer,gross_usdt,relay_fee_usdt,refunded_usdt,net_usdt,status,tx_hash,block,log_index\n";
    const r = await run(emptyCsv, metaText, chain, { expected: { fromBlock: meta.fromBlock, toBlock: meta.toBlock } });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("missing_row");
  });
});

describe("second RPC cross-check (L4)", () => {
  it("passes when both nodes agree", async () => {
    const chain = scenario();
    const { csv, metaText } = await valid();
    const r = await run(csv, metaText, chain, { src2: scenario() });
    expect(r.issues).toEqual([]);
  });

  it("fails when the second node serves different logs", async () => {
    const chain = scenario();
    const { csv, metaText } = await valid();
    const liar = scenario();
    liar.logs = liar.logs.slice(0, -2);
    const r = await run(csv, metaText, chain, { src2: liar });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("rpc_disagreement");
  });
});
