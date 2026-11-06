import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAddress } from "viem";
import { formatHuman } from "./report.js";
import type { VerifierSource } from "./types.js";
import { verifyLedger } from "./verify.js";

export const USAGE = `quietpay-verifier verify --csv FILE --rpc URL --router 0x.. --usdt 0x.. (--payto 0x.. | --no-payto)
                         [--meta FILE] [--report FILE] [--json]
                         [--from BLOCK] [--to BLOCK] [--min-confirmations N] [--rpc2 URL]
  Recomputes a ledger export from chain logs and checks the CSV and its .meta.json sidecar.
  --payto     the facilitator pay-to address the export was made with (FACILITATOR_PAYTO)
  --no-payto  the export was made WITHOUT a pay-to address. One of --payto / --no-payto is required: the sidecar
              never decides whether deposits are checked, and it must name the same pay-to (or null).
  --meta    sidecar path (default FILE.meta.json)
  --report  where to write the JSON report (default FILE.verify.json)
  --json    print the JSON report instead of the human report
  --from/--to  the block range you expect, taken from outside the export. Fails if the sidecar says otherwise
               (a forger can shrink the range in both files). Always compare the printed checkpoint out of band.
  --min-confirmations  fail if the export used a shallower finality depth
  --rpc2    a second node; fails if it serves different logs for the range
Exit codes: 0 everything matches, 1 mismatch, 2 usage or RPC error.`;

export interface CliDeps {
  makeSource: (rpcUrl: string) => VerifierSource;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const VALUE_FLAGS = new Set(["csv", "rpc", "router", "usdt", "payto", "meta", "report", "from", "to", "min-confirmations", "rpc2"]);
const BOOL_FLAGS = new Set(["json", "help", "no-payto"]);

function parseArgs(args: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (name in out) throw new Error(`--${name} given more than once`);
    if (BOOL_FLAGS.has(name)) out[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      out[name] = v;
    } else throw new Error(`unknown flag --${name}`);
  }
  return out;
}

/** Hides the RPC URL (it may carry an API key) in anything printed. */
function redact(msg: string, rpcUrl: string | undefined): string {
  if (!rpcUrl) return msg;
  let s = msg.split(rpcUrl).join("<rpc>");
  try {
    const u = new URL(rpcUrl);
    s = s.split(u.origin + u.pathname).join("<rpc>");
  } catch {
    /* not a URL */
  }
  return s;
}

/** Runs the CLI. Returns the exit code: 0 OK, 1 mismatch, 2 usage/RPC/config error. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h") {
    deps.stdout(USAGE);
    return 0;
  }
  if (cmd !== "verify") {
    deps.stderr(cmd ? `unknown command ${cmd}\n${USAGE}` : USAGE);
    return 2;
  }
  let f: Record<string, string | true>;
  try {
    f = parseArgs(rest);
  } catch (e) {
    deps.stderr(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (f.help) {
    deps.stdout(USAGE);
    return 0;
  }
  const str = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
  const csvPath = str("csv");
  const rpcUrl = str("rpc");
  const router = str("router");
  const usdt = str("usdt");
  const payTo = str("payto");
  for (const [k, v] of [["csv", csvPath], ["rpc", rpcUrl], ["router", router], ["usdt", usdt]] as const) {
    if (!v) {
      deps.stderr(`missing --${k}\n${USAGE}`);
      return 2;
    }
  }
  if (payTo !== undefined && f["no-payto"]) {
    deps.stderr(`--payto and --no-payto contradict each other; pass exactly one
${USAGE}`);
    return 2;
  }
  if (payTo === undefined && !f["no-payto"]) {
    deps.stderr(
      `missing pay-to expectation: pass --payto <address> if the export was made with FACILITATOR_PAYTO, or --no-payto if it was made without one (the sidecar is not trusted to decide)
${USAGE}`,
    );
    return 2;
  }
  for (const [k, v] of [["router", router], ["usdt", usdt], ["payto", payTo]] as const) {
    if (v !== undefined && !isAddress(v, { strict: false })) {
      deps.stderr(`--${k} is not an address: ${v}`);
      return 2;
    }
  }
  const uint = (k: string): number | undefined | "bad" => {
    const v = str(k);
    if (v === undefined) return undefined;
    return /^\d{1,15}$/.test(v) ? Number(v) : "bad";
  };
  const fromBlock = uint("from");
  const toBlock = uint("to");
  const minConf = uint("min-confirmations");
  for (const [k, v] of [["from", fromBlock], ["to", toBlock], ["min-confirmations", minConf]] as const) {
    if (v === "bad") {
      deps.stderr(`--${k} must be a non-negative integer`);
      return 2;
    }
  }
  const rpc2 = str("rpc2");
  const metaPath = str("meta") ?? `${csvPath}.meta.json`;
  const reportPath = str("report") ?? `${csvPath}.verify.json`;
  if (!existsSync(csvPath!)) {
    deps.stderr(`CSV not found: ${csvPath}`);
    return 2;
  }
  if (!existsSync(metaPath)) {
    deps.stderr(`sidecar not found: ${metaPath} (export writes FILE and FILE.meta.json)`);
    return 2;
  }

  try {
    const report = await verifyLedger({
      csvText: readFileSync(csvPath!, "utf8"),
      metaText: readFileSync(metaPath, "utf8"),
      src: deps.makeSource(rpcUrl!),
      router: router!,
      usdt: usdt!,
      expectedPayTo: payTo === undefined ? null : payTo,
      expected: { fromBlock: fromBlock as number | undefined, toBlock: toBlock as number | undefined, minConfirmations: minConf as number | undefined },
      src2: rpc2 ? deps.makeSource(rpc2) : undefined,
      sleep: deps.sleep,
    });
    const json = JSON.stringify({ csv: csvPath, meta: metaPath, ...report }, null, 2) + "\n";
    writeFileSync(reportPath, json);
    deps.stdout(f.json ? json.trimEnd() : `${formatHuman(report, csvPath)}\nJSON report: ${reportPath}`);
    return report.ok ? 0 : 1;
  } catch (e) {
    const err = e as Error;
    const kind = err.name === "ConfigError" ? "config error" : "error (RPC or I/O)";
    deps.stderr(`${kind}: ${redact(err.message ?? String(e), rpcUrl)}`);
    return 2;
  }
}
