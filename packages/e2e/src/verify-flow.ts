import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Stack } from "./stack.js";
import { redact, repoRoot } from "./util.js";

function runNode(cwd: string, args: string[], env: Record<string, string>, timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const c = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
    c.once("exit", (code) => { clearTimeout(t); res({ code: code ?? 1, out: redact(out) }); });
  });
}

export interface VerifyResult {
  okExit: number; okOut: string; tamperExit: number; tamperOut: string; rows: number;
  from: number; to: number; checkpoint: string; csv: string;
}

/**
 * Runs the real indexer CLI (index + export) and the real verifier CLI with the anchored flags
 * (--no-payto, --from/--to taken from outside the export, --min-confirmations), then verifies a CSV with one
 * altered amount and expects failure.
 */
export async function runIndexVerify(
  s: Stack,
  o: { from: number; confirmations: number; label: string; rpcUrl?: string; deployBlock?: number },
): Promise<VerifyResult> {
  const rpc = o.rpcUrl ?? s.chainRpc;
  const dir = resolve(s.tmp, `verify-${o.label}`);
  mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    RPC_URL: rpc, CHAIN_ID: "1874", USDT_ADDRESS: s.usdt, ROUTER_ADDRESS: s.router,
    DATABASE_PATH: resolve(dir, "indexer.db"), CONFIRMATIONS: String(o.confirmations),
    ...(o.deployBlock !== undefined ? { DEPLOY_BLOCK: String(o.deployBlock) } : {}),
  };
  const idx = await runNode(resolve(repoRoot, "packages/indexer"), ["src/cli.ts", "index"], env);
  if (idx.code !== 0) throw new Error(`indexer failed: ${idx.out.slice(-500)}`);
  const m = /finalized (\d+)/.exec(idx.out);
  if (!m) throw new Error(`could not read the finalized head: ${idx.out.slice(-300)}`);
  const to = Number(m[1]);
  const csv = resolve(dir, "export.csv");
  const exp = await runNode(resolve(repoRoot, "packages/indexer"), ["src/cli.ts", "export", "--from", String(o.from), "--to", String(to), "--out", csv], env);
  if (exp.code !== 0) throw new Error(`export failed: ${exp.out.slice(-500)}`);
  const vargs = (file: string) => ["src/cli.ts", "verify", "--csv", file, "--meta", `${csv}.meta.json`, "--rpc", rpc, "--router", s.router, "--usdt", s.usdt,
    "--no-payto", "--from", String(o.from), "--to", String(to), "--min-confirmations", String(o.confirmations), "--report", resolve(dir, "report.json")];
  const ok = await runNode(resolve(repoRoot, "packages/verifier"), vargs(csv), {});
  // Tampered copy: one amount digit changed in the first data row.
  const lines = readFileSync(csv, "utf8").split("\n");
  const rows = lines.filter((l, i) => i > 0 && l.trim() !== "").length;
  const bad = resolve(dir, "tampered.csv");
  const mutated = lines.map((l, i) => (i === 1 ? l.replace(/(\b\d{6,})\b/, (d) => (d.endsWith("0") ? d.slice(0, -1) + "1" : d.slice(0, -1) + "0")) : l));
  writeFileSync(bad, mutated.join("\n"));
  copyFileSync(`${csv}.meta.json`, `${bad}.meta.json`);
  const tamper = await runNode(resolve(repoRoot, "packages/verifier"), vargs(bad).map((a) => (a === `${csv}.meta.json` ? `${bad}.meta.json` : a)).concat([]).map((a) => a), {});
  const cp = /checkpoint[^\n]*/i.exec(ok.out)?.[0] ?? ok.out.trim().split("\n").slice(-1)[0] ?? "";
  return { okExit: ok.code, okOut: ok.out, tamperExit: tamper.code, tamperOut: tamper.out, rows, from: o.from, to, checkpoint: cp, csv };
}
