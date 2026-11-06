/**
 * Prints pass/fail for each qualification item the Lead owns. Exits 1 on any Lead failure.
 *   pnpm exec tsx scripts/qualify-check.ts [--offline]
 * --offline skips the explorer lookup (reported as SKIP, not PASS).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const isFile = (f: string) => existsSync(f) && statSync(f).isFile();

type Result = { name: string; status: "PASS" | "FAIL" | "SKIP" | "EXTERNAL"; detail: string };
const results: Result[] = [];
const add = (name: string, status: Result["status"], detail: string) => results.push({ name, status, detail });
const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const offline = process.argv.includes("--offline");

const deployments = JSON.parse(readFileSync("contracts/deployments.json", "utf8"))["1874"];
const readme = readFileSync("README.md", "utf8");

async function main() {
  // 1. Contract deployed with the official USDT, flagged qualifying.
  const official = "0xcedfb56113143d55b2358b8cfbb0deb5ad2f55a7";
  add(
    "router entry is qualifying and uses the official USDT",
    deployments?.qualifying === true && String(deployments.token).toLowerCase() === official ? "PASS" : "FAIL",
    `${deployments?.router} / ${deployments?.token}`,
  );

  // 2. Source verified on the explorer.
  if (offline) add("router source verified on the explorer", "SKIP", "--offline");
  else {
    try {
      const apiBase = (process.env.EXPLORER_API_BASE ?? "https://explorer.testnet.whitechain.io").replace(/[/]$/, "");
      const r = await fetch(`${apiBase}/api/v2/smart-contracts/${deployments.router}`);
      const j = (await r.json()) as { is_verified?: boolean; is_fully_verified?: boolean };
      add("router source verified on the explorer", j.is_verified || j.is_fully_verified ? "PASS" : "FAIL", `HTTP ${r.status}`);
    } catch (e) {
      add("router source verified on the explorer", "FAIL", `explorer unreachable: ${(e as Error).message}`);
    }
  }

  // 2b. The deployed router's token() is the official USDT, read from chain (needs RPC_URL; skipped with --offline).
  if (offline || !process.env.RPC_URL) add("router on-chain token matches", "SKIP", offline ? "--offline" : "RPC_URL not set");
  else {
    try {
      const res = await fetch(process.env.RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // 0xfc0c546a = token()
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: deployments.router, data: "0xfc0c546a" }, "latest"] }),
      });
      const j = (await res.json()) as { result?: string; error?: { message?: string } };
      const onChain = typeof j.result === "string" && /^0x[0-9a-fA-F]{64}$/.test(j.result) ? "0x" + j.result.slice(26).toLowerCase() : "";
      add("router on-chain token matches", onChain === official ? "PASS" : "FAIL", onChain ? `token() = ${onChain}` : `no token() result: ${j.error?.message ?? "empty"}`);
    } catch (err) {
      add("router on-chain token matches", "FAIL", `RPC unreachable: ${(err as Error).message}`);
    }
  }

  // 3. A qualifying payment is linked from the README.
  const tx = /explorer\.testnet\.whitechain\.io\/tx\/(0x[0-9a-fA-F]{64})/g;
  const txs = new Set([...readme.matchAll(tx)].map((m) => m[1]!.toLowerCase()));
  add("README links the qualifying payment and refund transactions", txs.size >= 3 ? "PASS" : "FAIL", `${txs.size} distinct tx links`);

  // 4. Why-onchain lines for Operate and Scale.
  const why = readme.split(/^## Why onchain/m)[1]?.split(/^## /m)[0] ?? "";
  add("README has why-onchain lines for Operate and Scale", /\*\*Operate/.test(why) && /\*\*Scale/.test(why) ? "PASS" : "FAIL", "");

  // 5. Feedback file.
  add("WHITECHAIN_FEEDBACK.md present and non-trivial", existsSync("WHITECHAIN_FEEDBACK.md") && readFileSync("WHITECHAIN_FEEDBACK.md", "utf8").length > 600 ? "PASS" : "FAIL", "");

  // 6. No stand-in token references in tracked source (history notes in docs and deployments.json are allowed).
  const tracked = git("ls-files").split("\n").filter((f) => /\.(ts|tsx|sol|mjs|js|json|yml|yaml)$/.test(f) && !f.startsWith("docs/") && f !== "contracts/deployments.json" && !f.includes("pnpm-lock") && !f.startsWith("scripts/qualify-check"));
  const hits = tracked.filter((f) => isFile(f) && /DemoUSDT|DEPLOY_DEMO_TOKEN/.test(readFileSync(f, "utf8")));
  add("no demo-token references in tracked source", hits.length === 0 ? "PASS" : "FAIL", hits.join(", "));

  // 7. No secrets in the tree or in history.
  const keyAssign = /(PRIVATE_KEY|SECRET|MNEMONIC)\w*["']?\s*[:=]\s*["']?(0x)?[0-9a-fA-F]{64}\b/;
  const treeHits = git("ls-files").split("\n").filter((f) => isFile(f) && !/\.(png|jpg|lock)$/.test(f) && !f.includes("fixtures/") && !f.includes("pnpm-lock") && keyAssign.test(readFileSync(f, "utf8")));
  add("no private-key assignments in the working tree", treeHits.length === 0 ? "PASS" : "FAIL", treeHits.join(", "));
  const hist = git("log", "-p", "--all", "-G", "(PRIVATE_KEY|SECRET|MNEMONIC)\\w*['\"]?\\s*[:=]\\s*['\"]?(0x)?[0-9a-fA-F]{64}").split("\n").filter((l) => l.startsWith("+") && keyAssign.test(l));
  add("no private-key assignments in git history", hist.length === 0 ? "PASS" : "FAIL", hist.length ? `${hist.length} added line(s) match` : "");
  add("env files are untracked", !git("ls-files").split("\n").some((f) => /(^|\/)\.env(\..+)?$/.test(f) && !/\.(example|sample|template)$/.test(f)) ? "PASS" : "FAIL", "");

  // 8. Steady commit history from the Lead.
  const dates = git("log", "--format=%ad", "--date=format:%Y-%m-%d %H").split("\n").filter(Boolean);
  const hours = new Set(dates).size;
  add("commit history shows steady progress", dates.length >= 40 && hours >= 8 ? "PASS" : "FAIL", `${dates.length} commits across ${hours} distinct hours`);
  add("Person A and B commit history", "EXTERNAL", "check feat/frontend and feat/backend on GitHub");

  for (const r of results) console.log(`[${r.status.padEnd(8)}] ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(failed ? `\n${failed} Lead item(s) failed` : "\nAll Lead items pass");
  process.exit(failed ? 1 : 0);
}

main();
