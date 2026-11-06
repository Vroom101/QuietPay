import type { VerifyReport } from "./types.js";

/** Escapes control, DEL, C1 and bidi-override characters so text copied from a hostile file cannot drive the terminal. */
export function safeText(s: string): string {
  const BS = String.fromCharCode(92);
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const bad = c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    out += bad ? BS + "u" + c.toString(16).padStart(4, "0") : ch;
  }
  return out;
}

/** Plain-text report for people. The JSON report carries the same facts. */
export function formatHuman(r: VerifyReport, csvPath?: string): string {
  const L: string[] = [];
  L.push("QuietPay ledger verifier");
  if (csvPath) L.push(`  file          ${csvPath}`);
  L.push(`  chain         ${r.chainId}`);
  L.push(`  router        ${r.router}`);
  L.push(`  usdt          ${r.usdt}`);
  L.push(`  pay-to        ${r.payTo ?? "(none: router rows only)"}`);
  if (r.fromBlock !== null) {
    L.push(`  range         blocks ${r.fromBlock}-${r.toBlock}, ${r.confirmations} confirmations`);
  }
  if (r.headBlock !== null) L.push(`  node head     ${r.headBlock}, finalized ${r.finalizedBlock}`);
  L.push(`  rows          ${r.rowsInCsv} in CSV, ${r.rowsExpected ?? "-"} rebuilt from ${r.eventsInRange ?? "-"} chain events`);
  L.push(`  eventSetHash  sidecar    ${r.eventSetHash.sidecar ?? "-"}`);
  L.push(`                recomputed ${r.eventSetHash.recomputed ?? "-"}`);
  if (r.checkpoint) {
    L.push(`  checkpoint    blocks ${r.checkpoint.fromBlock}-${r.checkpoint.toBlock}, ${r.checkpoint.eventCount} events, hash ${r.checkpoint.eventSetHash}`);
    L.push("                (compare this line with the publisher out of band; a self-consistent but truncated file differs here)");
  }
  L.push("");
  L.push("Checks");
  for (const [name, status] of Object.entries(r.checks)) L.push(`  [${status.toUpperCase().padEnd(7)}] ${name}`);
  if (r.issues.length) {
    L.push("");
    L.push(`Issues (${r.issues.length})`);
    for (const i of r.issues) {
      const where = [i.line !== undefined ? `line ${i.line}` : "", i.field ?? ""].filter(Boolean).join(" ");
      L.push(`  - ${i.code}${where ? ` (${where})` : ""}: ${i.message}`);
    }
  }
  L.push("");
  L.push(`RESULT: ${r.ok ? (r.anchored ? "OK" : "OK (unanchored: pass --from, --to and --min-confirmations from outside the file to rule out a shrunken range)") : "FAIL"}`);
  L.push(`Note: ${r.trust}`);
  return L.map(safeText).join("\n");
}
