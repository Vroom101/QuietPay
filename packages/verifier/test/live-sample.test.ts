import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QUALIFYING_USDT, getQualifyingDeployment } from "@quietpay/shared";
import { makeVerifierSource, runCli } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const sample = resolve(here, "../../../docs/lead/samples/live-sample.csv");
// Read-only check against the public testnet. The RPC URL comes from the environment only.
const rpcUrl = process.env.RPC_URL;

describe.skipIf(!rpcUrl)("live sample (read-only, public testnet, needs RPC_URL)", () => {
  it("the committed live sample verifies against chain 1874", async () => {
    const dep = getQualifyingDeployment();
    const report = join(mkdtempSync(join(tmpdir(), "qp-verifier-live-")), "live.verify.json");
    const argv = ["verify", "--csv", sample, "--rpc", rpcUrl!, "--router", dep.router, "--usdt", QUALIFYING_USDT, "--report", report];
    if (process.env.VERIFY_PAYTO) argv.push("--payto", process.env.VERIFY_PAYTO);
    const lines: string[] = [];
    const code = await runCli(argv, { makeSource: makeVerifierSource, stdout: (s) => lines.push(s), stderr: (s) => lines.push(s) });
    console.log(lines.join("\n"));
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(report, "utf8")).chainId).toBe(1874);
  }, 300_000);
});
