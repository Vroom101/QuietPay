/**
 * Writes the three broken variants used in the demo video next to a clean export.
 *   pnpm exec tsx scripts/make-tampered-samples.ts [clean.csv] [outDir]
 * Defaults: docs/lead/samples/live-sample.csv -> docs/lead/samples/tampered/
 * Then verify each with the printed command; the clean file must pass and each variant must fail with its code.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { makeTamperedSamples } from "../packages/verifier/src/tamper.js";

const csvPath = process.argv[2] ?? "docs/lead/samples/live-sample.csv";
const outDir = process.argv[3] ?? "docs/lead/samples/tampered";
const csv = readFileSync(csvPath, "utf8");
const meta = readFileSync(`${csvPath}.meta.json`, "utf8");
mkdirSync(outDir, { recursive: true });

for (const s of makeTamperedSamples(csv, meta)) {
  const out = join(outDir, `${basename(csvPath, ".csv")}.${s.name}.csv`);
  writeFileSync(out, s.csv);
  writeFileSync(`${out}.meta.json`, s.meta);
  console.log(`${out}\n  ${s.note}\n  expect: ${s.expect}${s.verifierArgs.length ? `  (run the verifier with ${s.verifierArgs.join(" ")})` : ""}`);
}
console.log("\nVerify with: pnpm --filter @quietpay/verifier cli verify --csv <file> --rpc $RPC_URL --router <router> --usdt <usdt> (--payto <address> | --no-payto)");
