import { createPublicClient, http } from "viem";
import { loadConfig } from "./config.js";
import { runPreflight, formatPreflight, preflightToJson, settingsFromEnv, fundNeeds, type PreflightResult } from "./preflight-checks.js";

/**
 * `tsx src/preflight-cli.ts [--json] [--fund]` (wrapped by deploy/preflight.mjs and deploy/fund-check.mjs).
 * Read-only: never signs or sends. Prints no secret, and a config that cannot even load is reported as a failure.
 */
const json = process.argv.includes("--json");
const fund = process.argv.includes("--fund");

function configFailure(e: unknown): PreflightResult {
  // ZodError messages and ConfigError text never include secret values; still print only the issue paths for zod.
  const issues = (e as { issues?: { path: (string | number)[] }[] }).issues;
  const msg = issues ? `invalid or missing environment: ${issues.map((i) => i.path.join(".")).join(", ")}` : e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
  return { ok: false, checks: [{ code: "TOKEN_QUALIFYING", status: "fail", message: `configuration refused: ${msg}` }] };
}

let exit = 0;
try {
  let cfg;
  try { cfg = loadConfig(); } catch (e) { const r = configFailure(e); console.log(json ? preflightToJson(r) : formatPreflight(r)); process.exit(1); }
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const settings = settingsFromEnv();
  if (fund) {
    const needs = await fundNeeds(cfg, { client: client as never, settings });
    console.log(json ? JSON.stringify({ needs }) : needs.map((n) => `${n.short ? "NEEDS FUNDS" : "ok         "}  ${n.wallet.padEnd(14)} ${n.address}  ${n.asset}: has ${n.have}, needs ${n.need}`).join("\n"));
    exit = needs.some((n) => n.short) ? 1 : 0;
  } else {
    const r = await runPreflight(cfg, { client: client as never, settings });
    console.log(json ? preflightToJson(r) : formatPreflight(r));
    exit = r.ok ? 0 : 1;
  }
} catch (e) {
  console.error("Preflight could not run:", e instanceof Error ? e.name : "error");
  exit = 1;
}
process.exitCode = exit;
