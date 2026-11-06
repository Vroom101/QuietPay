import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { FakeChain, PAYTO, ROUTER, USDT, exportWithIndexer, scenario } from "./fake.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
}

async function files(chain: FakeChain) {
  const dir = mkdtempSync(join(tmpdir(), "qp-verifier-"));
  const { csv, metaText } = await exportWithIndexer(chain);
  const csvPath = join(dir, "ledger.csv");
  writeFileSync(csvPath, csv);
  writeFileSync(`${csvPath}.meta.json`, metaText);
  return { dir, csvPath, csv };
}

const base = (csv: string) => ["verify", "--csv", csv, "--rpc", "http://fake", "--router", ROUTER, "--usdt", USDT, "--payto", PAYTO];

describe("cli", () => {
  it("exit 0 for a correct file, prints a human report and writes the JSON report", async () => {
    const chain = scenario();
    const { csvPath } = await files(chain);
    const o = io();
    const code = await runCli(base(csvPath), { makeSource: () => chain, ...o, sleep: async () => undefined });
    expect(code).toBe(0);
    expect(o.out.join("\n")).toMatch(/RESULT: OK/);
    const json = JSON.parse(readFileSync(`${csvPath}.verify.json`, "utf8"));
    expect(json.ok).toBe(true);
    expect(json.issues).toEqual([]);
  });

  it("--report writes the JSON elsewhere and --json prints it", async () => {
    const chain = scenario();
    const { csvPath, dir } = await files(chain);
    const o = io();
    const report = join(dir, "r.json");
    expect(await runCli([...base(csvPath), "--report", report, "--json"], { makeSource: () => chain, ...o })).toBe(0);
    expect(JSON.parse(readFileSync(report, "utf8")).ok).toBe(true);
    expect(JSON.parse(o.out.join("\n")).ok).toBe(true);
  });

  it("exit 1 on a mismatch, with the reason in the human report", async () => {
    const chain = scenario();
    const { csvPath, csv } = await files(chain);
    writeFileSync(csvPath, csv.replace("25.000000", "26.000000"));
    const o = io();
    expect(await runCli(base(csvPath), { makeSource: () => chain, ...o })).toBe(1);
    const text = o.out.join("\n");
    expect(text).toMatch(/RESULT: FAIL/);
    expect(text).toMatch(/wrong_amount/);
    expect(text).toMatch(/gross_usdt/);
  });

  it("exit 2 on usage errors", async () => {
    const o = io();
    expect(await runCli(["verify", "--rpc", "x"], { makeSource: () => scenario(), ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/--csv/);
    expect(await runCli([], { makeSource: () => scenario(), ...io() })).toBe(2);
    expect(await runCli(["verify", "--csv", "nope.csv", "--rpc", "x", "--router", ROUTER, "--usdt", USDT, "--no-payto"], { makeSource: () => scenario(), ...io() })).toBe(2);
    expect(await runCli(["verify", "--csv", "a.csv", "--rpc", "x", "--router", "0x12", "--usdt", USDT, "--no-payto"], { makeSource: () => scenario(), ...io() })).toBe(2);
  });

  it("exit 2 when the sidecar is missing", async () => {
    const chain = scenario();
    const { dir, csv } = await files(chain);
    const lone = join(dir, "lone.csv");
    writeFileSync(lone, csv);
    const o = io();
    expect(await runCli(base(lone), { makeSource: () => chain, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/meta\.json/);
  });

  it("exit 2 on an RPC error", async () => {
    const chain = scenario();
    const { csvPath } = await files(chain);
    chain.failWith = new Error("connect ECONNREFUSED");
    const o = io();
    expect(await runCli(base(csvPath), { makeSource: () => chain, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/ECONNREFUSED/);
  });

  it("exit 2 on the qualifying guard (chain 1874, wrong token)", async () => {
    const chain = scenario();
    const { csvPath } = await files(chain);
    chain.chainId = 1874;
    const o = io();
    expect(await runCli(base(csvPath), { makeSource: () => chain, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/Wrong token/);
  });
});

describe("cli expected range and second node (L4)", () => {
  it("--from/--to exit 1 when the sidecar range differs, 0 when it matches, and print the checkpoint", async () => {
    const chain = scenario();
    const { csvPath } = await files(chain);
    const meta = JSON.parse(readFileSync(`${csvPath}.meta.json`, "utf8"));
    const ok = io();
    expect(await runCli([...base(csvPath), "--from", String(meta.fromBlock), "--to", String(meta.toBlock)], { makeSource: () => chain, ...ok })).toBe(0);
    expect(ok.out.join("\n")).toMatch(/checkpoint/i);
    const bad = io();
    expect(await runCli([...base(csvPath), "--from", String(meta.fromBlock), "--to", String(meta.toBlock + 5)], { makeSource: () => chain, ...bad })).toBe(1);
    expect(bad.out.join("\n")).toMatch(/range_mismatch/);
  });

  it("rejects a non-integer --from and a missing value", async () => {
    const chain = scenario();
    const { csvPath } = await files(chain);
    for (const args of [["--from", "abc"], ["--to", "-1"], ["--min-confirmations", "1.5"]]) {
      const o = io();
      expect(await runCli([...base(csvPath), ...args], { makeSource: () => chain, ...o })).toBe(2);
    }
  });

  it("--rpc2 exits 1 when the second node disagrees", async () => {
    const chain = scenario();
    const liar = scenario();
    liar.logs = liar.logs.slice(0, -3);
    const { csvPath } = await files(chain);
    const o = io();
    const code = await runCli([...base(csvPath), "--rpc2", "http://liar"], { makeSource: (u) => (u.includes("liar") ? liar : chain), ...o });
    expect(code).toBe(1);
    expect(o.out.join("\n")).toMatch(/rpc_disagreement/);
  });
});
