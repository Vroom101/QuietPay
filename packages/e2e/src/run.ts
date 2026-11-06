import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { attacks, newEvidence, runScenarios, scenarios } from "./scenarios.js";
import { startLocalStack } from "./stack.js";
import { killAllTracked } from "./procs.js";
import { log, repoRoot, setLogFile } from "./util.js";

/**
 * Entry for deploy/e2e.mjs.
 *   local (default): anvil + the real router bytecode + the real relayer child, scenarios S1-S10 and attacks A1-A8
 *   --live         : the real testnet subset (see live.ts); needs the env loaded with node --env-file
 * Flags: --only S1,S3   --no-attacks   --report FILE
 */
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (n: string) => args.includes(`--${n}`);

process.on("exit", () => killAllTracked());
process.on("SIGINT", () => { killAllTracked(); process.exit(130); });

async function main(): Promise<number> {
  if (has("live")) {
    const { runLive } = await import("./live.js");
    await runLive({ evidencePath: resolve(repoRoot, "docs/b/build/live-evidence.md"), confirmWrite: !has("no-evidence") });
    return 0;
  }
  const only = flag("only")?.split(",");
  const list = [...scenarios, ...(has("no-attacks") ? [] : attacks)].filter((s) => !only || only.includes(s.id));
  const s = await startLocalStack();
  setLogFile(resolve(s.tmp, "e2e.log"));
  log(`local stack up: anvil pid ${s.anvil?.pid}, relayer pid ${s.relayer.pid}, tmp ${s.tmp}`);
  const ev = newEvidence();
  try {
    const res = await runScenarios(s, list, ev);
    log("\nSummary");
    for (const r of res) log(`  ${r.ok ? "PASS" : "FAIL"} ${r.id}${r.err ? ` - ${r.err.split("\n")[0]}` : ""}`);
    for (const t of ev.txs) log(`  tx ${t.label}: ${t.hash}`);
    for (const n of ev.notes) log(`  ${n}`);
    const rep = flag("report");
    if (rep) { mkdirSync(dirname(resolve(rep)), { recursive: true }); writeFileSync(resolve(rep), JSON.stringify({ res, ev }, null, 2)); }
    return res.every((r) => r.ok) ? 0 : 1;
  } finally {
    await s.stop();
  }
}
main().then((c) => process.exit(c), (e) => { console.error(String((e as Error).stack ?? e)); killAllTracked(); process.exit(2); });
