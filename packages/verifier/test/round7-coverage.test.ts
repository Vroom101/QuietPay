/**
 * Round 7 residual (after R7-V1): the sidecar must never decide what the reader checks. The reader states the pay-to
 * expectation explicitly (`--payto <address>` / `expectedPayTo: address`, or `--no-payto` / `expectedPayTo: null`);
 * stating nothing refuses verification. Local only: in-memory fake node, no testnet, no real keys.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "@quietpay/shared";
import { runCli, verifyLedger, type VerifyInput, type VerifyReport } from "../src/index.js";
import { PAYTO, ROUTER, USDT, exportWithIndexer, scenario } from "./fake.js";

const codes = (r: VerifyReport) => r.issues.map((i) => i.code);
const stripDeposits = (csv: string) =>
  csv
    .split("\n")
    .filter((l) => !l.includes(",payto_transfer,"))
    .join("\n");

/** The forger's files: deposits removed, sidecar rebuilt over router events only, pins kept, payTo set to null. */
async function forgedRouterOnly() {
  const chain = scenario();
  const real = await exportWithIndexer(chain);
  expect(real.csv).toContain(",payto_transfer,");
  const routerOnly = await exportWithIndexer(scenario(), { payTo: null });
  expect(stripDeposits(real.csv)).toBe(routerOnly.csv);
  expect(routerOnly.meta.payTo).toBeNull();
  return { chain, real, csv: stripDeposits(real.csv), metaText: JSON.stringify(routerOnly.meta) };
}

const anchored = (m: { fromBlock: number; toBlock: number }) => ({ fromBlock: m.fromBlock, toBlock: m.toBlock, minConfirmations: 12 });

describe("pay-to expectation is required and decided by the reader (programmatic API)", () => {
  it("payTo:null forged sidecar + omitted expectation => refused, never OK (even anchored)", async () => {
    const { chain, real, csv, metaText } = await forgedRouterOnly();
    // Only an untyped caller can omit it; the type requires expectedPayTo.
    const input = { csvText: csv, metaText, src: chain, router: ROUTER, usdt: USDT, expected: anchored(real.meta), sleep: async () => undefined } as unknown as VerifyInput;
    const r = await verifyLedger(input);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["payto_expectation_missing"]);
    expect(r.checks.sidecar).toBe("fail");
    expect(r.checks.rows).toBe("skipped");
    expect(r.issues[0]!.message).toMatch(/--payto <address>.*--no-payto/);
    expect(chain.requests).toEqual([]); // refused before any log is read
  });

  it("an explicit undefined expectation is refused the same way, and so is a legitimate file", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain, { payTo: null });
    const input = { csvText: csv, metaText, src: chain, router: ROUTER, usdt: USDT, expectedPayTo: undefined, sleep: async () => undefined } as unknown as VerifyInput;
    const r = await verifyLedger(input);
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["payto_expectation_missing"]);
  });

  it("--no-payto (expectedPayTo: null) on a sidecar that has a real payTo => config_mismatch, not OK", async () => {
    const chain = scenario();
    const { csv, metaText, meta } = await exportWithIndexer(chain);
    expect(meta.payTo).toBe(PAYTO);
    const r = await verifyLedger({ csvText: csv, metaText, src: chain, router: ROUTER, usdt: USDT, expectedPayTo: null, sleep: async () => undefined });
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === "config_mismatch")).toMatchObject({ field: "payTo", expected: PAYTO, actual: "null" });
  });

  it("--payto mismatch => config_mismatch, not OK", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain);
    const other = "0x8888888888888888888888888888888888888888";
    const r = await verifyLedger({ csvText: csv, metaText, src: chain, router: ROUTER, usdt: USDT, expectedPayTo: other, sleep: async () => undefined });
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === "config_mismatch")).toMatchObject({ field: "payTo", expected: PAYTO, actual: other });
  });

  it("stripped deposits + payTo:null + --payto <real> => not OK (config_mismatch and the hidden deposit is named)", async () => {
    const { chain, real, csv, metaText } = await forgedRouterOnly();
    const r = await verifyLedger({ csvText: csv, metaText, src: chain, router: ROUTER, usdt: USDT, expectedPayTo: PAYTO, expected: anchored(real.meta), sleep: async () => undefined });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("config_mismatch");
    expect(codes(r)).toContain("missing_row");
    expect(codes(r)).toContain("event_set_hash_mismatch");
  });

  it("the pay-to address matches case-insensitively", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain);
    const r = await verifyLedger({ csvText: csv, metaText, src: chain, router: ROUTER, usdt: USDT, expectedPayTo: PAYTO.toUpperCase().replace("0X", "0x"), sleep: async () => undefined });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("legitimate exports still verify OK with the matching explicit expectation", async () => {
    const a = scenario();
    const withPayTo = await exportWithIndexer(a);
    expect((await verifyLedger({ csvText: withPayTo.csv, metaText: withPayTo.metaText, src: a, router: ROUTER, usdt: USDT, expectedPayTo: PAYTO, expected: anchored(withPayTo.meta), sleep: async () => undefined })).ok).toBe(true);
    const b = scenario();
    const without = await exportWithIndexer(b, { payTo: null });
    expect((await verifyLedger({ csvText: without.csv, metaText: without.metaText, src: b, router: ROUTER, usdt: USDT, expectedPayTo: null, expected: anchored(without.meta), sleep: async () => undefined })).ok).toBe(true);
  });

  it("a bad or contradictory expectation is a config error", async () => {
    const chain = scenario();
    const { csv, metaText } = await exportWithIndexer(chain);
    const base = { csvText: csv, metaText, src: chain, router: ROUTER, usdt: USDT, sleep: async () => undefined };
    await expect(verifyLedger({ ...base, expectedPayTo: "0x12" })).rejects.toBeInstanceOf(ConfigError);
    await expect(verifyLedger({ ...base, expectedPayTo: "" })).rejects.toBeInstanceOf(ConfigError);
    await expect(verifyLedger({ ...base, expectedPayTo: null, payTo: PAYTO } as unknown as VerifyInput)).rejects.toBeInstanceOf(ConfigError);
    await expect(verifyLedger({ ...base, payTo: null } as unknown as VerifyInput)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("pay-to expectation is required (CLI)", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) };
  }
  async function forgedFiles() {
    const f = await forgedRouterOnly();
    const dir = mkdtempSync(join(tmpdir(), "qp-verifier-r7c-"));
    const csvPath = join(dir, "ledger.csv");
    writeFileSync(csvPath, f.csv);
    writeFileSync(`${csvPath}.meta.json`, f.metaText);
    return { ...f, csvPath };
  }
  const args = (csv: string) => ["verify", "--csv", csv, "--rpc", "http://fake", "--router", ROUTER, "--usdt", USDT];

  it("omitting both --payto and --no-payto exits 2 with a clear message and never reads the chain", async () => {
    const { chain, real, csvPath } = await forgedFiles();
    const o = io();
    const code = await runCli([...args(csvPath), "--from", String(real.meta.fromBlock), "--to", String(real.meta.toBlock), "--min-confirmations", "12"], { makeSource: () => chain, ...o });
    expect(code).toBe(2);
    expect(o.err.join("\n")).toMatch(/missing pay-to expectation.*--payto <address>.*--no-payto/);
    expect(o.out).toEqual([]);
    expect(chain.requests).toEqual([]);
  });

  it("--payto together with --no-payto exits 2", async () => {
    const { chain, csvPath } = await forgedFiles();
    const o = io();
    expect(await runCli([...args(csvPath), "--payto", PAYTO, "--no-payto"], { makeSource: () => chain, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/contradict/);
  });

  it("a repeated --payto exits 2 instead of silently taking the last one", async () => {
    const { chain, csvPath } = await forgedFiles();
    const o = io();
    expect(await runCli([...args(csvPath), "--payto", PAYTO, "--payto", "0x8888888888888888888888888888888888888888"], { makeSource: () => chain, ...o })).toBe(2);
    expect(o.err.join("\n")).toMatch(/more than once/);
  });

  it("forged files + --payto <real> exit 1 with config_mismatch", async () => {
    const { chain, csvPath } = await forgedFiles();
    const o = io();
    expect(await runCli([...args(csvPath), "--payto", PAYTO, "--json"], { makeSource: () => chain, ...o })).toBe(1);
    const rep = JSON.parse(readFileSync(`${csvPath}.verify.json`, "utf8"));
    expect(rep.ok).toBe(false);
    expect(rep.issues.map((i: { code: string }) => i.code)).toContain("config_mismatch");
  });

  it("--no-payto on an export that has a real payTo exits 1 with config_mismatch; --no-payto on a router-only export exits 0", async () => {
    const chain = scenario();
    const dir = mkdtempSync(join(tmpdir(), "qp-verifier-r7c-"));
    const withPayTo = await exportWithIndexer(chain);
    const p1 = join(dir, "with.csv");
    writeFileSync(p1, withPayTo.csv);
    writeFileSync(`${p1}.meta.json`, withPayTo.metaText);
    expect(await runCli([...args(p1), "--no-payto"], { makeSource: () => chain, ...io() })).toBe(1);
    expect(JSON.parse(readFileSync(`${p1}.verify.json`, "utf8")).issues.map((i: { code: string }) => i.code)).toContain("config_mismatch");

    const chain2 = scenario();
    const routerOnly = await exportWithIndexer(chain2, { payTo: null });
    const p2 = join(dir, "router-only.csv");
    writeFileSync(p2, routerOnly.csv);
    writeFileSync(`${p2}.meta.json`, routerOnly.metaText);
    const o = io();
    expect(await runCli([...args(p2), "--no-payto"], { makeSource: () => chain2, ...o })).toBe(0);
    expect(o.out.join("\n")).toMatch(/RESULT: OK/);
  });
});
