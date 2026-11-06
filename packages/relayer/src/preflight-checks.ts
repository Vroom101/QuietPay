import { getAddress, hashDomain, isAddress, parseAbi, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { lstatSync, accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { paymentRouterAbi, QUALIFYING_CHAIN_ID, QUALIFYING_USDT, assertQualifyingConfig, getQualifyingDeployment } from "@quietpay/shared";
import type { Config } from "./config.js";
import { webhookUrlProblem, deliveryTargetProblem, type LookupFn } from "./webhooks.js";

/**
 * Structured, read-only deployment preflight. It never signs or broadcasts anything, never prints a secret,
 * and fails closed: a check that cannot run is a failure, never a pass.
 */

export type CheckStatus = "pass" | "fail" | "warn";
export interface PreflightCheck { code: string; status: CheckStatus; message: string }
export interface PreflightResult { ok: boolean; checks: PreflightCheck[] }

/** Stable codes, in the order they are reported. */
export const PREFLIGHT_CODES = [
  "CONFIG_INPUT", "CHAIN_ID", "TOKEN_QUALIFYING", "ADDRESS_FORMAT", "ROUTER_CODE", "ROUTER_TOKEN", "TOKEN_DOMAIN",
  "MERCHANT_REGISTERED", "RELAYER_ALLOWLISTED", "ROUTER_NOT_PAUSED", "RELAYER_WBT", "PAYER_NO_GAS", "PAYER_USDT",
  "REFUND_SIGNER_USDT", "SECRETS", "DATABASE_PATH", "PORT_PUBLIC_URL", "PUBLIC_URLS", "SINGLE_INSTANCE",
] as const;

/** Facts about the official test USDT (address from the shared qualifying module). */
export const TOKEN_FACTS = { address: QUALIFYING_USDT, name: "Tether USD", version: "1", decimals: 6 } as const;
export const MIN_SECRET_LENGTH = 24;
/** Gas of one plain transfer, with a 1.5x safety factor (applied as 3/2). */
const TRANSFER_GAS = 21_000n;

export interface ExpectedMerchant { payout: string; refundSigner: string; maxRelayFee?: bigint }

export interface PreflightSettings {
  /** Keyed by lowercase merchantId (0x bytes32). */
  expectedMerchants: Record<string, ExpectedMerchant>;
  payer?: string;
  refundSigner?: string;
  minRelayerWei: bigint;
  plannedPayerUsdt: bigint;
  plannedRefundSignerUsdt: bigint;
  publicUrl?: string;
  port?: string;
  /** Webhook and resource URLs (everything the service will call or advertise). */
  urls: string[];
  /** The raw INSTANCE_COUNT value; must be exactly "1". */
  instanceCount?: string;
  /** Problems found while parsing the environment (surfaced as CONFIG_INPUT). */
  inputErrors: string[];
}

export interface PreflightClient {
  getChainId(): Promise<number>;
  getCode(a: { address: `0x${string}` }): Promise<string | undefined>;
  getBalance(a: { address: `0x${string}` }): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  readContract(a: any): Promise<any>;
}

export interface PreflightFs {
  lstat(path: string): { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; mode: number };
  /** Throws when the path is not writable by this process. */
  assertWritable(path: string): void;
}

export const nodeFs: PreflightFs = {
  lstat: (p) => lstatSync(p),
  assertWritable: (p) => accessSync(p, constants.W_OK),
};

export interface PreflightDeps {
  client: PreflightClient;
  settings: PreflightSettings;
  fs?: PreflightFs;
  platform?: string;
  /** Resolve host names and refuse private results (optional; the static URL policy always runs). */
  lookup?: LookupFn;
  /** Tests only, never set from the environment: run against a non-qualifying chain and token (local anvil). */
  nonQualifyingForTests?: boolean;
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function DOMAIN_SEPARATOR() view returns (bytes32)"]);

/** Strict address handling: no whitespace, 40 hex chars; mixed case must carry a valid EIP-55 checksum. Returns checksummed or null. */
export function normaliseAddress(raw: unknown): `0x${string}` | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  const body = raw.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && !isAddress(raw, { strict: true })) return null;
  return getAddress(raw.toLowerCase());
}

const DEFAULT_MIN_RELAYER_WBT = "0.1";
const DEFAULT_PLANNED_USDT = "1";

function amount(env: Record<string, string | undefined>, key: string, dflt: string, places: number, errors: string[]): bigint {
  const raw = (env[key] ?? dflt);
  if (!new RegExp(`^[0-9]+(?:\\.[0-9]{1,${places}})?$`).test(raw)) { errors.push(`${key} must be a plain non-negative decimal`); return 0n; }
  return parseUnits(raw, places);
}
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Reads the preflight-only inputs from the environment. Defaults the merchant expectations to the recorded deployment. */
export function settingsFromEnv(env: Record<string, string | undefined> = process.env): PreflightSettings {
  const inputErrors: string[] = [];
  const expectedMerchants: Record<string, ExpectedMerchant> = {};
  try {
    const d = getQualifyingDeployment();
    for (const m of Object.values(d.merchants ?? {})) expectedMerchants[m.merchantId.toLowerCase()] = { payout: m.payout, refundSigner: m.refundSigner };
  } catch { inputErrors.push("no qualifying deployment record to take merchant expectations from"); }
  const firstRefundSigner = Object.values(expectedMerchants)[0]?.refundSigner;
  return {
    expectedMerchants,
    payer: env.PAYER_ADDRESS,
    refundSigner: env.REFUND_SIGNER_ADDRESS ?? firstRefundSigner,
    minRelayerWei: amount(env, "MIN_RELAYER_WBT", DEFAULT_MIN_RELAYER_WBT, 18, inputErrors),
    plannedPayerUsdt: amount(env, "PLANNED_PAYER_USDT", DEFAULT_PLANNED_USDT, 6, inputErrors),
    plannedRefundSignerUsdt: amount(env, "PLANNED_REFUND_SIGNER_USDT", DEFAULT_PLANNED_USDT, 6, inputErrors),
    publicUrl: env.PUBLIC_URL,
    port: env.PORT,
    urls: [...list(env.WEBHOOK_URLS), ...list(env.RESOURCE_URLS)],
    instanceCount: env.INSTANCE_COUNT,
    inputErrors,
  };
}

const pass = (code: string, message: string): PreflightCheck => ({ code, status: "pass", message });
const fail = (code: string, message: string): PreflightCheck => ({ code, status: "fail", message });
/** An error label that cannot leak: RPC errors can embed the endpoint URL (which may carry a key). */
const label = (e: unknown) => (e instanceof Error ? e.name : "Error");

type Run = () => Promise<PreflightCheck> | PreflightCheck;

export async function runPreflight(cfg: Config, deps: PreflightDeps): Promise<PreflightResult> {
  const { client, settings: s } = deps;
  const fs = deps.fs ?? nodeFs;
  const platform = deps.platform ?? process.platform;
  const qualifying = !deps.nonQualifyingForTests;
  const expectedChain = qualifying ? QUALIFYING_CHAIN_ID : cfg.chainId;

  const usdt = normaliseAddress(cfg.usdt);
  const router = normaliseAddress(cfg.router);
  const payer = normaliseAddress(s.payer);
  const refundSigner = normaliseAddress(s.refundSigner);
  let relayer: `0x${string}` | null = null;
  try { relayer = privateKeyToAccount(cfg.relayerKey).address; } catch { relayer = null; }
  let nodeChainId: number | null = null;

  const rpc = async <T,>(f: () => Promise<T>): Promise<T> => f();
  const gasThreshold = async (): Promise<bigint> => (await client.getGasPrice()) * TRANSFER_GAS * 3n / 2n;

  const checks: Record<string, Run> = {
    CONFIG_INPUT: () => s.inputErrors.length ? fail("CONFIG_INPUT", s.inputErrors.join("; ")) : pass("CONFIG_INPUT", "preflight inputs parsed"),

    CHAIN_ID: async () => {
      nodeChainId = await rpc(() => client.getChainId());
      if (nodeChainId !== expectedChain) return fail("CHAIN_ID", `node reports chain ${nodeChainId}, expected ${expectedChain}`);
      if (cfg.chainId !== expectedChain) return fail("CHAIN_ID", `CHAIN_ID is ${cfg.chainId}, expected ${expectedChain}`);
      return pass("CHAIN_ID", `chain ${nodeChainId}`);
    },

    TOKEN_QUALIFYING: () => {
      if (!qualifying) return pass("TOKEN_QUALIFYING", "skipped (test mode)");
      assertQualifyingConfig({ chainId: cfg.chainId, tokenAddress: String(cfg.usdt) });
      return pass("TOKEN_QUALIFYING", "token is the official USDT");
    },

    ADDRESS_FORMAT: () => {
      const bad = [["USDT_ADDRESS", usdt], ["ROUTER_ADDRESS", router], ["PAYER_ADDRESS", payer], ["REFUND_SIGNER_ADDRESS", refundSigner]].filter(([, v]) => !v).map(([k]) => k);
      for (const [id, m] of Object.entries(s.expectedMerchants)) {
        if (!normaliseAddress(m.payout) || !normaliseAddress(m.refundSigner)) bad.push(`expected merchant ${id.slice(0, 10)}`);
      }
      return bad.length ? fail("ADDRESS_FORMAT", `missing or malformed address (whitespace, wrong length or bad checksum): ${bad.join(", ")}`) : pass("ADDRESS_FORMAT", "addresses well formed");
    },

    ROUTER_CODE: async () => {
      if (!router) return fail("ROUTER_CODE", "router address malformed");
      const code = await client.getCode({ address: router });
      return !code || code === "0x" ? fail("ROUTER_CODE", "router has no deployed bytecode") : pass("ROUTER_CODE", "router bytecode present");
    },

    ROUTER_TOKEN: async () => {
      if (!router || !usdt) return fail("ROUTER_TOKEN", "router or token address malformed");
      const tokenCode = await client.getCode({ address: usdt });
      if (!tokenCode || tokenCode === "0x") return fail("ROUTER_TOKEN", "token has no deployed bytecode");
      const t = String(await client.readContract({ address: router, abi: paymentRouterAbi, functionName: "token" }));
      return t.toLowerCase() === usdt.toLowerCase() ? pass("ROUTER_TOKEN", "router.token() equals the configured USDT") : fail("ROUTER_TOKEN", "router.token() differs from the configured USDT");
    },

    TOKEN_DOMAIN: async () => {
      if (!usdt) return fail("TOKEN_DOMAIN", "token address malformed");
      if (cfg.tokenDomain.name !== TOKEN_FACTS.name || cfg.tokenDomain.version !== TOKEN_FACTS.version) return fail("TOKEN_DOMAIN", "TOKEN_DOMAIN_NAME/VERSION differ from the known token facts");
      const [decimals, sep] = await Promise.all([
        client.readContract({ address: usdt, abi: erc20, functionName: "decimals" }),
        client.readContract({ address: usdt, abi: erc20, functionName: "DOMAIN_SEPARATOR" }),
      ]);
      if (Number(decimals) !== TOKEN_FACTS.decimals) return fail("TOKEN_DOMAIN", "token decimals differ from the known token facts");
      const expected = hashDomain({
        types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
        domain: { name: TOKEN_FACTS.name, version: TOKEN_FACTS.version, chainId: BigInt(nodeChainId ?? expectedChain), verifyingContract: usdt },
      });
      return String(sep).toLowerCase() === expected.toLowerCase() ? pass("TOKEN_DOMAIN", "on-chain EIP-712 domain matches the token facts") : fail("TOKEN_DOMAIN", "on-chain EIP-712 domain differs from the token facts");
    },

    MERCHANT_REGISTERED: async () => {
      if (!router) return fail("MERCHANT_REGISTERED", "router address malformed");
      const ids = [...new Set(cfg.apiKeys.values())];
      if (ids.length === 0) return fail("MERCHANT_REGISTERED", "no merchant configured");
      const problems: string[] = [];
      for (const id of ids) {
        const short = id.slice(0, 10);
        const want = s.expectedMerchants[id.toLowerCase()];
        const got = (await client.readContract({ address: router, abi: paymentRouterAbi, functionName: "merchants", args: [id] })) as readonly [string, string, bigint];
        if (/^0x0{40}$/i.test(got[0])) { problems.push(`${short} not registered`); continue; }
        if (!want) { problems.push(`${short} registered but has no expected record`); continue; }
        if (got[0].toLowerCase() !== want.payout.toLowerCase()) problems.push(`${short} payout differs`);
        if (got[1].toLowerCase() !== want.refundSigner.toLowerCase()) problems.push(`${short} refund signer differs`);
        if (want.maxRelayFee !== undefined && BigInt(got[2]) !== want.maxRelayFee) problems.push(`${short} maxRelayFee differs`);
      }
      return problems.length ? fail("MERCHANT_REGISTERED", problems.join("; ")) : pass("MERCHANT_REGISTERED", `${ids.length} merchant(s) registered as expected`);
    },

    RELAYER_ALLOWLISTED: async () => {
      if (!router || !relayer) return fail("RELAYER_ALLOWLISTED", "router address or relayer key malformed");
      const ok = await client.readContract({ address: router, abi: paymentRouterAbi, functionName: "isRelayer", args: [relayer] });
      return ok === true ? pass("RELAYER_ALLOWLISTED", `relayer ${relayer} is allowlisted`) : fail("RELAYER_ALLOWLISTED", `relayer ${relayer} is not allowlisted`);
    },

    ROUTER_NOT_PAUSED: async () => {
      if (!router) return fail("ROUTER_NOT_PAUSED", "router address malformed");
      const p = await client.readContract({ address: router, abi: paymentRouterAbi, functionName: "paused" });
      return p === false ? pass("ROUTER_NOT_PAUSED", "router is not paused") : fail("ROUTER_NOT_PAUSED", "router is paused");
    },

    RELAYER_WBT: async () => {
      if (!relayer) return fail("RELAYER_WBT", "relayer key malformed");
      const b = await client.getBalance({ address: relayer });
      return b >= s.minRelayerWei ? pass("RELAYER_WBT", `relayer holds ${formatUnits(b, 18)} WBT`) : fail("RELAYER_WBT", `relayer holds ${formatUnits(b, 18)} WBT, needs at least ${formatUnits(s.minRelayerWei, 18)}`);
    },

    PAYER_NO_GAS: async () => {
      if (!payer) return fail("PAYER_NO_GAS", "payer address missing or malformed");
      const [b, limit] = await Promise.all([client.getBalance({ address: payer }), gasThreshold()]);
      // Dust below the cost of one transfer is fine (recorded decision); exactly zero is not required.
      return b === 0n || b < limit ? pass("PAYER_NO_GAS", `payer cannot pay gas (${formatUnits(b, 18)} WBT, one transfer costs ${formatUnits(limit, 18)})`) : fail("PAYER_NO_GAS", `payer holds ${formatUnits(b, 18)} WBT, enough for a transfer (${formatUnits(limit, 18)})`);
    },

    PAYER_USDT: async () => usdtCheck("PAYER_USDT", payer, s.plannedPayerUsdt, "payer"),
    REFUND_SIGNER_USDT: async () => usdtCheck("REFUND_SIGNER_USDT", refundSigner, s.plannedRefundSignerUsdt, "refund signer"),

    SECRETS: () => {
      const problems: string[] = [];
      const check = (name: string, v: string | undefined) => {
        if (!v) problems.push(`${name} missing`);
        else if (v.length < MIN_SECRET_LENGTH) problems.push(`${name} shorter than ${MIN_SECRET_LENGTH}`);
        else if (v !== v.trim()) problems.push(`${name} has leading or trailing whitespace`);
      };
      check("OPERATOR_TOKEN", cfg.operatorToken);
      check("WEBHOOK_SECRET", cfg.webhookSecret);
      if (cfg.apiKeys.size === 0) problems.push("MERCHANT_API_KEYS missing");
      let i = 0;
      for (const k of cfg.apiKeys.keys()) check(`MERCHANT_API_KEYS[${i++}]`, k);
      return problems.length ? fail("SECRETS", problems.join("; ")) : pass("SECRETS", "all keys and secrets present and long enough");
    },

    DATABASE_PATH: () => {
      const p = cfg.databasePath;
      if (!p || p === ":memory:") return fail("DATABASE_PATH", "DATABASE_PATH must be a file on disk");
      let st;
      try { st = fs.lstat(p); } catch { return fail("DATABASE_PATH", "database file does not exist"); }
      if (st.isSymbolicLink()) return fail("DATABASE_PATH", "database path is a symlink");
      if (!st.isFile()) return fail("DATABASE_PATH", "database path is not a regular file");
      const winNote = platform === "win32";
      if (!winNote && (st.mode & 0o002) !== 0) return fail("DATABASE_PATH", "database file is world-writable");
      try {
        const dir = fs.lstat(dirname(p));
        if (!winNote && (dir.mode & 0o002) !== 0 && (dir.mode & 0o1000) === 0) return fail("DATABASE_PATH", "database directory is world-writable");
      } catch { return fail("DATABASE_PATH", "database directory is not accessible"); }
      try { fs.assertWritable(p); } catch { return fail("DATABASE_PATH", "database file is not writable"); }
      return pass("DATABASE_PATH", winNote ? "database file exists, writable, not a symlink (mode bits not enforced on win32)" : "database file exists, writable, not a symlink, not world-writable");
    },

    PORT_PUBLIC_URL: () => {
      const problems: string[] = [];
      if (!s.port || !/^[0-9]{1,5}$/.test(s.port) || Number(s.port) < 1 || Number(s.port) > 65535) problems.push("PORT unset or invalid");
      if (!s.publicUrl) problems.push("PUBLIC_URL unset");
      return problems.length ? fail("PORT_PUBLIC_URL", problems.join("; ")) : pass("PORT_PUBLIC_URL", "PORT and PUBLIC_URL set");
    },

    PUBLIC_URLS: async () => {
      const all = [...(s.publicUrl ? [s.publicUrl] : []), ...s.urls];
      const problems: string[] = [];
      for (const [i, u] of all.entries()) {
        let p: string | null = webhookUrlProblem(u, false);
        if (!p && !/^https:\/\//i.test(u)) p = "must use https";
        if (!p && deps.lookup) p = await deliveryTargetProblem(u, false, deps.lookup);
        if (p) problems.push(`url #${i + 1}: ${p}`);
      }
      return problems.length ? fail("PUBLIC_URLS", problems.join("; ")) : pass("PUBLIC_URLS", `${all.length} url(s) are public https`);
    },

    SINGLE_INSTANCE: () => s.instanceCount === "1"
      ? pass("SINGLE_INSTANCE", "INSTANCE_COUNT is 1 (the relayer nonce and loss budget assume a single instance)")
      : fail("SINGLE_INSTANCE", "INSTANCE_COUNT must be exactly 1"),
  };

  async function usdtCheck(code: string, who: `0x${string}` | null, need: bigint, name: string): Promise<PreflightCheck> {
    if (!who || !usdt) return fail(code, `${name} or token address missing or malformed`);
    const b = BigInt(await client.readContract({ address: usdt, abi: erc20, functionName: "balanceOf", args: [who] }));
    return b >= need ? pass(code, `${name} holds ${formatUnits(b, 6)} USDT`) : fail(code, `${name} holds ${formatUnits(b, 6)} USDT, needs ${formatUnits(need, 6)}`);
  }

  const out: PreflightCheck[] = [];
  for (const code of PREFLIGHT_CODES) {
    try {
      out.push(await checks[code]!());
    } catch (e) {
      // Fail closed. The message carries only the error class: RPC errors can embed URLs with keys.
      out.push(fail(code, `check could not run (${label(e)})`));
    }
  }
  const secrets = [...cfg.apiKeys.keys(), cfg.operatorToken, cfg.webhookSecret, cfg.relayerKey, cfg.rpcUrl].filter((x) => typeof x === "string" && x.length >= 8);
  const scrubbed = out.map((c) => ({ ...c, message: secrets.reduce((m, sec) => m.split(sec).join("[redacted]"), c.message) }));
  return { ok: scrubbed.every((c) => c.status !== "fail"), checks: scrubbed };
}

/** JSON-printable form (stable key order). */
export function preflightToJson(r: PreflightResult): string {
  return JSON.stringify({ ok: r.ok, checks: r.checks.map(({ code, status, message }) => ({ code, status, message })) });
}

/** Human form, one line per check. */
export function formatPreflight(r: PreflightResult): string {
  const lines = r.checks.map((c) => `${c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL"}  ${c.code.padEnd(20)} ${c.message}`);
  lines.push(r.ok ? "Preflight OK" : "Preflight FAILED: the service must not start");
  return lines.join("\n");
}

/** Read-only funding report: which wallet needs what. Never sends. */
export interface FundNeed { wallet: string; address: string; asset: "WBT" | "USDT"; have: string; need: string; short: boolean }
export async function fundNeeds(cfg: Config, deps: Pick<PreflightDeps, "client" | "settings">): Promise<FundNeed[]> {
  const { client, settings: s } = deps;
  const out: FundNeed[] = [];
  const relayer = privateKeyToAccount(cfg.relayerKey).address;
  const wbt = async (wallet: string, a: string | null, need: bigint) => {
    const addr = normaliseAddress(a);
    if (!addr) return void out.push({ wallet, address: "malformed", asset: "WBT", have: "?", need: formatUnits(need, 18), short: true });
    const b = await client.getBalance({ address: addr });
    out.push({ wallet, address: addr, asset: "WBT", have: formatUnits(b, 18), need: formatUnits(need, 18), short: b < need });
  };
  const usdt = async (wallet: string, a: string | undefined, need: bigint) => {
    const addr = normaliseAddress(a);
    const token = normaliseAddress(cfg.usdt);
    if (!addr || !token) return void out.push({ wallet, address: "malformed", asset: "USDT", have: "?", need: formatUnits(need, 6), short: true });
    const b = BigInt(await client.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [addr] }));
    out.push({ wallet, address: addr, asset: "USDT", have: formatUnits(b, 6), need: formatUnits(need, 6), short: b < need });
  };
  await wbt("relayer", relayer, s.minRelayerWei);
  await usdt("payer", s.payer, s.plannedPayerUsdt);
  await usdt("refund signer", s.refundSigner, s.plannedRefundSignerUsdt);
  return out;
}
