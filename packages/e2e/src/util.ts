import { appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");

/** Names of environment variables whose values must never reach any output. */
export const SENSITIVE_ENV = [
  "RPC_URL", "RELAYER_PRIVATE_KEY", "PAYER_PRIVATE_KEY", "REFUND_SIGNER_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY",
  "MERCHANT_PAYOUT_PRIVATE_KEY", "MERCHANT_API_KEY", "WEBHOOK_SECRET", "OPERATOR_TOKEN", "EXPLORER_API_KEY", "EXPLORER_VERIFIER_URL",
] as const;

const extra = new Set<string>();
/** Registers a derived secret (for example a per-merchant webhook secret) so it is scrubbed too. */
export function addSecret(v: string | undefined) {
  if (v && v.length >= 6) extra.add(v);
}

function secretStrings(): string[] {
  const out = new Set<string>(extra);
  for (const n of SENSITIVE_ENV) {
    const v = process.env[n];
    if (!v || v.length < 6) continue;
    out.add(v);
    if (/^0x/i.test(v)) out.add(v.slice(2));
    if (/^https?:\/\//i.test(v)) {
      try {
        const u = new URL(v);
        out.add(u.host);
        for (const seg of u.pathname.split("/")) if (seg.length >= 8) out.add(seg);
        for (const [, val] of u.searchParams) if (val.length >= 6) out.add(val);
      } catch { /* not a URL */ }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replaces every secret value (and pieces of the RPC URL) by [redacted]. */
export function redact(s: string): string {
  let r = s;
  for (const v of secretStrings()) r = r.split(v).join("[redacted]");
  return r;
}

let logFile: string | undefined;
export function setLogFile(p: string | undefined) {
  logFile = p;
}
export function log(...parts: unknown[]) {
  const line = redact(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))).join(" "));
  console.log(line);
  if (logFile) appendFileSync(logFile, line + "\n");
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitUntil<T>(fn: () => Promise<T | undefined | false | null> | T | undefined | false | null, what: string, timeoutMs = 30_000, stepMs = 150): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

/** Compiled contract artifacts: this worktree's contracts/out, else CONTRACTS_OUT, else the main checkout's (read only). */
export function contractsOut(): string {
  const cands = [process.env.CONTRACTS_OUT, resolve(repoRoot, "contracts/out"), resolve(repoRoot, "../QuietPay/contracts/out")].filter(Boolean) as string[];
  for (const c of cands) if (existsSync(resolve(c, "PaymentRouter.sol/PaymentRouter.json"))) return c;
  throw new Error("contracts/out not found: run `forge build` in contracts or set CONTRACTS_OUT");
}

export const explorerTx = (hash: string) => `https://explorer.testnet.whitechain.io/tx/${hash}`;
