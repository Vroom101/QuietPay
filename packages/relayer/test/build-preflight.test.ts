import { describe, expect, it } from "vitest";
import { hashDomain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QUALIFYING_USDT, getQualifyingDeployment } from "@quietpay/shared";
import {
  runPreflight, formatPreflight, preflightToJson, settingsFromEnv, fundNeeds, normaliseAddress, PREFLIGHT_CODES,
  type PreflightClient, type PreflightFs, type PreflightSettings, type PreflightCheck,
} from "../src/preflight-checks.js";
import * as publicApi from "../src/preflight.js";
import { makeCfg, MERCHANT_ID, PAYOUT, refundSigner, payer, ROUTER } from "./helpers.js";

const WITH_SECRETS = {
  apiKeys: new Map([["merchant-api-key-0123456789abcdef", MERCHANT_ID]]),
  operatorToken: "operator-token-0123456789abcdef",
  webhookSecret: "webhook-secret-0123456789abcdef",
  usdt: QUALIFYING_USDT as `0x${string}`,
  router: ROUTER,
};
const cfgOk = (over = {}) => makeCfg({ ...WITH_SECRETS, databasePath: "/data/quietpay.db", ...over });
const RELAYER = privateKeyToAccount(makeCfg().relayerKey).address;
const GAS_PRICE = 1_000_000_000n;

const domainSep = (chainId = 1874) =>
  hashDomain({
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
    domain: { name: "Tether USD", version: "1", chainId: BigInt(chainId), verifyingContract: QUALIFYING_USDT },
  });

interface World {
  chainId: number; code: Record<string, string>; token: string; sep: string; decimals: number;
  merchant: [string, string, bigint]; relayerAllowed: boolean; paused: boolean;
  wbt: Record<string, bigint>; usdt: Record<string, bigint>; gasPrice: bigint; throwOn?: string;
}
const world = (over: Partial<World> = {}): World => ({
  chainId: 1874,
  code: { [ROUTER.toLowerCase()]: "0x60", [QUALIFYING_USDT.toLowerCase()]: "0x60" },
  token: QUALIFYING_USDT, sep: domainSep(), decimals: 6,
  merchant: [PAYOUT, refundSigner.address, 100_000n], relayerAllowed: true, paused: false,
  wbt: { [RELAYER.toLowerCase()]: 5n * 10n ** 18n, [payer.address.toLowerCase()]: 9_990_000_000n },
  usdt: { [payer.address.toLowerCase()]: 99_500_000n, [refundSigner.address.toLowerCase()]: 99_500_000n },
  gasPrice: GAS_PRICE, ...over,
});

function mockClient(w: World): PreflightClient {
  const maybeThrow = (what: string) => { if (w.throwOn === what) throw Object.assign(new Error("boom http://rpc.example/key-SECRETKEY123"), { name: "HttpRequestError" }); };
  return {
    getChainId: async () => { maybeThrow("chain"); return w.chainId; },
    getCode: async ({ address }) => w.code[address.toLowerCase()],
    getBalance: async ({ address }) => w.wbt[address.toLowerCase()] ?? 0n,
    getGasPrice: async () => w.gasPrice,
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      maybeThrow(functionName);
      switch (functionName) {
        case "token": return w.token;
        case "DOMAIN_SEPARATOR": return w.sep;
        case "decimals": return w.decimals;
        case "merchants": return w.merchant;
        case "isRelayer": return w.relayerAllowed;
        case "paused": return w.paused;
        case "balanceOf": return w.usdt[String(args![0]).toLowerCase()] ?? 0n;
      }
      throw new Error("unexpected " + functionName);
    },
  };
}

const dbOk: PreflightFs = {
  lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => true, mode: 0o600 }),
  assertWritable: () => undefined,
};

const settings = (over: Partial<PreflightSettings> = {}): PreflightSettings => ({
  expectedMerchants: { [MERCHANT_ID.toLowerCase()]: { payout: PAYOUT, refundSigner: refundSigner.address, maxRelayFee: 100_000n } },
  payer: payer.address, refundSigner: refundSigner.address,
  minRelayerWei: 10n ** 17n, plannedPayerUsdt: 1_000_000n, plannedRefundSignerUsdt: 1_000_000n,
  publicUrl: "https://relayer.example.com", port: "8787", urls: ["https://shop.example.com/hook", "https://api.example.com/resource"],
  instanceCount: "1", inputErrors: [], ...over,
});

const run = (o: { w?: Partial<World>; cfg?: object; s?: Partial<PreflightSettings>; fs?: PreflightFs; platform?: string } = {}) =>
  runPreflight(cfgOk(o.cfg), { client: mockClient(world(o.w)), settings: settings(o.s), fs: o.fs ?? dbOk, platform: o.platform ?? "linux" });
const get = (r: { ok?: boolean; checks: PreflightCheck[] }, code: string) => r.checks.find((c) => c.code === code)!;

describe("preflight: baseline", () => {
  it("passes everything for a funded and registered setup and reports all stable codes in order", async () => {
    const r = await run();
    expect(r.checks.map((c) => c.code)).toEqual([...PREFLIGHT_CODES]);
    expect(r.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it("is re-exported from preflight.ts next to the original preflight()", () => {
    expect(typeof publicApi.preflight).toBe("function");
    expect(publicApi.runPreflight).toBe(runPreflight);
  });
  it("has a JSON-printable form with only code, status, message", async () => {
    const parsed = JSON.parse(preflightToJson(await run()));
    expect(parsed.ok).toBe(true);
    expect(Object.keys(parsed.checks[0]).sort()).toEqual(["code", "message", "status"]);
    expect(formatPreflight(await run())).toContain("Preflight OK");
  });
});

// One unit test per check: a passing and a failing mock.
describe("preflight: one check per code (pass and fail)", () => {
  const cases: [string, () => ReturnType<typeof run>, () => ReturnType<typeof run>][] = [
    ["CONFIG_INPUT", () => run(), () => run({ s: { inputErrors: ["MIN_RELAYER_WBT must be a plain non-negative decimal"] } })],
    ["CHAIN_ID", () => run(), () => run({ w: { chainId: 1 } })],
    ["TOKEN_QUALIFYING", () => run(), () => run({ cfg: { usdt: "0x0000000000000000000000000000000000000001" } })],
    ["ADDRESS_FORMAT", () => run(), () => run({ s: { payer: undefined } })],
    ["ROUTER_CODE", () => run(), () => run({ w: { code: { [QUALIFYING_USDT.toLowerCase()]: "0x60" } } })],
    ["ROUTER_TOKEN", () => run(), () => run({ w: { token: "0x0000000000000000000000000000000000000002" } })],
    ["TOKEN_DOMAIN", () => run(), () => run({ w: { sep: "0x" + "00".repeat(32) } })],
    ["MERCHANT_REGISTERED", () => run(), () => run({ w: { merchant: ["0x0000000000000000000000000000000000000000", refundSigner.address, 0n] } })],
    ["RELAYER_ALLOWLISTED", () => run(), () => run({ w: { relayerAllowed: false } })],
    ["ROUTER_NOT_PAUSED", () => run(), () => run({ w: { paused: true } })],
    ["RELAYER_WBT", () => run(), () => run({ w: { wbt: { [payer.address.toLowerCase()]: 0n } } })],
    ["PAYER_NO_GAS", () => run(), () => run({ w: { wbt: { [RELAYER.toLowerCase()]: 10n ** 18n, [payer.address.toLowerCase()]: 10n ** 18n } } })],
    ["PAYER_USDT", () => run(), () => run({ w: { usdt: { [refundSigner.address.toLowerCase()]: 99_500_000n } } })],
    ["REFUND_SIGNER_USDT", () => run(), () => run({ w: { usdt: { [payer.address.toLowerCase()]: 99_500_000n } } })],
    ["SECRETS", () => run(), () => run({ cfg: { webhookSecret: "short" } })],
    ["DATABASE_PATH", () => run(), () => run({ fs: { ...dbOk, lstat: () => { throw new Error("ENOENT"); } } })],
    ["PORT_PUBLIC_URL", () => run(), () => run({ s: { publicUrl: undefined } })],
    ["PUBLIC_URLS", () => run(), () => run({ s: { urls: ["http://shop.example.com/hook"] } })],
    ["SINGLE_INSTANCE", () => run(), () => run({ s: { instanceCount: "2" } })],
  ];
  it("covers every code", () => expect(cases.map((c) => c[0])).toEqual([...PREFLIGHT_CODES]));
  it.each(cases)("%s", async (code, good, bad) => {
    expect(get(await good(), code).status).toBe("pass");
    const r = await bad();
    expect(get(r, code).status).toBe("fail");
    expect(r.ok).toBe(false);
  });
});

describe("preflight: config rule matrix", () => {
  const matrix: [string, () => ReturnType<typeof run>, string, "pass" | "fail"][] = [
    ["payer dust below one transfer", () => run({ w: { wbt: { [RELAYER.toLowerCase()]: 10n ** 18n, [payer.address.toLowerCase()]: 9_990_000_000n } } }), "PAYER_NO_GAS", "pass"],
    ["payer exactly zero", () => run({ w: { wbt: { [RELAYER.toLowerCase()]: 10n ** 18n } } }), "PAYER_NO_GAS", "pass"],
    ["payer at exactly 1.5x transfer cost", () => run({ w: { wbt: { [RELAYER.toLowerCase()]: 10n ** 18n, [payer.address.toLowerCase()]: GAS_PRICE * 31_500n } } }), "PAYER_NO_GAS", "fail"],
    ["payer just under 1.5x transfer cost", () => run({ w: { wbt: { [RELAYER.toLowerCase()]: 10n ** 18n, [payer.address.toLowerCase()]: GAS_PRICE * 31_500n - 1n } } }), "PAYER_NO_GAS", "pass"],
    ["gas price 0 with positive payer balance", () => run({ w: { gasPrice: 0n } }), "PAYER_NO_GAS", "fail"],
    ["relayer exactly at minimum", () => run({ w: { wbt: { [RELAYER.toLowerCase()]: 10n ** 17n } } }), "RELAYER_WBT", "pass"],
    ["relayer one wei under minimum", () => run({ w: { wbt: { [RELAYER.toLowerCase()]: 10n ** 17n - 1n } } }), "RELAYER_WBT", "fail"],
    ["payer USDT exactly the plan", () => run({ w: { usdt: { [payer.address.toLowerCase()]: 1_000_000n, [refundSigner.address.toLowerCase()]: 1_000_000n } } }), "PAYER_USDT", "pass"],
    ["payer USDT one unit short", () => run({ w: { usdt: { [payer.address.toLowerCase()]: 999_999n, [refundSigner.address.toLowerCase()]: 1_000_000n } } }), "PAYER_USDT", "fail"],
    ["secret of 23 chars", () => run({ cfg: { operatorToken: "x".repeat(23) } }), "SECRETS", "fail"],
    ["secret of 24 chars", () => run({ cfg: { operatorToken: "x".repeat(24) } }), "SECRETS", "pass"],
    ["api key of 23 chars", () => run({ cfg: { apiKeys: new Map([["k".repeat(23), MERCHANT_ID]]) } }), "SECRETS", "fail"],
    ["secret with trailing space", () => run({ cfg: { webhookSecret: "w".repeat(30) + " " } }), "SECRETS", "fail"],
    ["INSTANCE_COUNT unset", () => run({ s: { instanceCount: undefined } }), "SINGLE_INSTANCE", "fail"],
    ["INSTANCE_COUNT '01'", () => run({ s: { instanceCount: "01" } }), "SINGLE_INSTANCE", "fail"],
    ["INSTANCE_COUNT '1'", () => run({ s: { instanceCount: "1" } }), "SINGLE_INSTANCE", "pass"],
    ["PORT 0", () => run({ s: { port: "0" } }), "PORT_PUBLIC_URL", "fail"],
    ["PORT 70000", () => run({ s: { port: "70000" } }), "PORT_PUBLIC_URL", "fail"],
    ["PORT unset", () => run({ s: { port: undefined } }), "PORT_PUBLIC_URL", "fail"],
    ["merchant maxRelayFee differs", () => run({ w: { merchant: [PAYOUT, refundSigner.address, 5n] } }), "MERCHANT_REGISTERED", "fail"],
    ["merchant payout differs", () => run({ w: { merchant: ["0x3333333333333333333333333333333333333333", refundSigner.address, 100_000n] } }), "MERCHANT_REGISTERED", "fail"],
    ["merchant refund signer differs", () => run({ w: { merchant: [PAYOUT, "0x3333333333333333333333333333333333333333", 100_000n] } }), "MERCHANT_REGISTERED", "fail"],
    ["registered merchant without an expected record", () => run({ s: { expectedMerchants: {} } }), "MERCHANT_REGISTERED", "fail"],
    ["URL to localhost", () => run({ s: { urls: ["https://localhost/hook"] } }), "PUBLIC_URLS", "fail"],
    ["URL to private IP", () => run({ s: { urls: ["https://10.0.0.5/hook"] } }), "PUBLIC_URLS", "fail"],
    ["URL to cloud metadata", () => run({ s: { urls: ["https://169.254.169.254/"] } }), "PUBLIC_URLS", "fail"],
    ["URL with credentials", () => run({ s: { urls: ["https://u:p@shop.example.com/"] } }), "PUBLIC_URLS", "fail"],
    ["PUBLIC_URL over http", () => run({ s: { publicUrl: "http://relayer.example.com" } }), "PUBLIC_URLS", "fail"],
    ["wrong token domain name", () => run({ cfg: { tokenDomain: { name: "Other", version: "1" } } }), "TOKEN_DOMAIN", "fail"],
    ["wrong decimals", () => run({ w: { decimals: 18 } }), "TOKEN_DOMAIN", "fail"],
    ["wrong cfg chain id with right node", () => run({ cfg: { chainId: 1 } }), "CHAIN_ID", "fail"],
  ];
  it.each(matrix)("%s", async (_n, f, code, expected) => {
    expect(get(await f(), code).status).toBe(expected);
  });
});

describe("preflight: database path", () => {
  const stat = (o: Partial<ReturnType<PreflightFs["lstat"]>>): PreflightFs => ({
    lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => true, mode: 0o600, ...o }),
    assertWritable: () => undefined,
  });
  it("refuses a symlink", async () => expect(get(await run({ fs: stat({ isSymbolicLink: () => true }) }), "DATABASE_PATH").status).toBe("fail"));
  it("refuses a world-writable file", async () => expect(get(await run({ fs: stat({ mode: 0o666 }) }), "DATABASE_PATH").message).toContain("world-writable"));
  it("refuses a world-writable directory without sticky bit", async () => {
    const fs: PreflightFs = { lstat: (p) => ({ isSymbolicLink: () => false, isFile: () => p.endsWith(".db"), isDirectory: () => !p.endsWith(".db"), mode: p.endsWith(".db") ? 0o600 : 0o777 }), assertWritable: () => undefined };
    expect(get(await run({ fs }), "DATABASE_PATH").status).toBe("fail");
  });
  it("accepts a sticky world-writable directory such as /tmp", async () => {
    const fs: PreflightFs = { lstat: (p) => ({ isSymbolicLink: () => false, isFile: () => p.endsWith(".db"), isDirectory: () => !p.endsWith(".db"), mode: p.endsWith(".db") ? 0o600 : 0o1777 }), assertWritable: () => undefined };
    expect(get(await run({ fs }), "DATABASE_PATH").status).toBe("pass");
  });
  it("refuses a missing file, a directory, an unwritable file, and :memory:", async () => {
    expect(get(await run({ fs: stat({ isFile: () => false }) }), "DATABASE_PATH").status).toBe("fail");
    expect(get(await run({ fs: { ...dbOk, assertWritable: () => { throw new Error("EACCES"); } } }), "DATABASE_PATH").status).toBe("fail");
    expect(get(await run({ cfg: { databasePath: ":memory:" } }), "DATABASE_PATH").status).toBe("fail");
  });
});

describe("Feature: startup refuses an unsafe deployment", () => {
  it("Scenario: a wrong token refuses startup", async () => {
    // Given the configuration names a token that is not the official USDT
    const cfg = cfgOk({ usdt: "0x0000000000000000000000000000000000000001" });
    // When the preflight runs
    const r = await runPreflight(cfg, { client: mockClient(world({ token: "0x0000000000000000000000000000000000000001" })), settings: settings(), fs: dbOk, platform: "linux" });
    // Then it is not ok and names the token check
    expect(r.ok).toBe(false);
    expect(get(r, "TOKEN_QUALIFYING").status).toBe("fail");
    expect(formatPreflight(r)).toContain("Preflight FAILED");
  });
  it("Scenario: a missing merchant refuses startup", async () => {
    // Given the router has no record for the configured merchant
    const w = { merchant: ["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0n] as [string, string, bigint] };
    // When the preflight runs
    const r = await run({ w });
    // Then startup is refused with MERCHANT_REGISTERED
    expect(r.ok).toBe(false);
    expect(get(r, "MERCHANT_REGISTERED").message).toContain("not registered");
  });
  it("Scenario: a funded and registered setup passes", async () => {
    // Given the official token, a registered merchant, an allowlisted funded relayer and a gasless payer
    // When the preflight runs
    const r = await run();
    // Then every check passes
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
  });
});

describe("preflight: attacks", () => {
  it("never prints secrets, even when an RPC error embeds a key", async () => {
    const cfg = cfgOk({ rpcUrl: "https://rpc.example.com/v1/RPCKEYSECRET99" });
    for (const throwOn of ["chain", "token", "merchants", "isRelayer", "paused", "balanceOf", "DOMAIN_SEPARATOR"]) {
      const r = await runPreflight(cfg, { client: mockClient(world({ throwOn })), settings: settings(), fs: dbOk, platform: "linux" });
      const out = preflightToJson(r) + formatPreflight(r);
      expect(r.ok).toBe(false);
      for (const secret of ["merchant-api-key-0123456789abcdef", "operator-token-0123456789abcdef", "webhook-secret-0123456789abcdef", cfg.relayerKey, "RPCKEYSECRET99", "SECRETKEY123"]) {
        expect(out).not.toContain(secret);
      }
    }
  });
  it("scrubs a secret that leaks into a message through user-controlled input", async () => {
    const r = await run({ cfg: { operatorToken: "operator-token-0123456789abcdef" }, s: { inputErrors: ["bad value operator-token-0123456789abcdef"] } });
    expect(JSON.stringify(r)).not.toContain("operator-token-0123456789abcdef");
  });
  it("short secrets are named but never echoed", async () => {
    const r = await run({ cfg: { webhookSecret: "tiny-secret-value" } });
    expect(get(r, "SECRETS").message).toContain("WEBHOOK_SECRET");
    expect(JSON.stringify(r)).not.toContain("tiny-secret-value");
  });
  it("an RPC outage fails closed on every on-chain check", async () => {
    const dead: PreflightClient = { getChainId: async () => { throw new Error("down"); }, getCode: async () => { throw new Error("down"); }, getBalance: async () => { throw new Error("down"); }, getGasPrice: async () => { throw new Error("down"); }, readContract: async () => { throw new Error("down"); } };
    const r = await runPreflight(cfgOk(), { client: dead, settings: settings(), fs: dbOk, platform: "linux" });
    for (const c of ["CHAIN_ID", "ROUTER_CODE", "ROUTER_TOKEN", "TOKEN_DOMAIN", "MERCHANT_REGISTERED", "RELAYER_ALLOWLISTED", "ROUTER_NOT_PAUSED", "RELAYER_WBT", "PAYER_NO_GAS", "PAYER_USDT", "REFUND_SIGNER_USDT"]) expect(get(r, c).status).toBe("fail");
    expect(r.ok).toBe(false);
  });
  it.each([
    ["leading space", " " + payer.address],
    ["trailing newline", payer.address + "\n"],
    ["empty", ""],
    ["short", payer.address.slice(0, 40)],
    ["no 0x", payer.address.slice(2)],
    ["bad checksum (one flipped case)", payer.address.replace(/[a-f]/i, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))],
    ["non-hex", "0x" + "zz".repeat(20)],
  ])("rejects a payer address: %s", async (_n, bad) => {
    expect(normaliseAddress(bad)).toBeNull();
    const r = await run({ s: { payer: bad } });
    expect(get(r, "ADDRESS_FORMAT").status).toBe("fail");
    expect(get(r, "PAYER_NO_GAS").status).toBe("fail");
  });
  it("normalises all-lowercase, all-uppercase and correctly checksummed addresses", async () => {
    expect(normaliseAddress(payer.address.toLowerCase())).toBe(payer.address);
    expect(normaliseAddress("0x" + payer.address.slice(2).toUpperCase())).toBe(payer.address);
    expect(normaliseAddress(payer.address)).toBe(payer.address);
    const r = await run({ s: { payer: payer.address.toLowerCase() } });
    expect(get(r, "PAYER_USDT").status).toBe("pass");
  });
  it("rejects a mixed-case address whose checksum is wrong", async () => {
    const flipped = "0x" + [...payer.address.slice(2)].map((ch, i) => (i === payer.address.slice(2).search(/[a-f]/i) ? (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) : ch)).join("");
    expect(flipped).not.toBe(payer.address);
    expect(normaliseAddress(flipped)).toBeNull();
  });
  it("refuses a real symlinked database path (skipped when the OS forbids symlinks)", async () => {
    const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "qp-pf-"));
    try {
      writeFileSync(join(dir, "real.db"), "");
      try { symlinkSync(join(dir, "real.db"), join(dir, "link.db")); } catch { return; }
      const r = await runPreflight(cfgOk({ databasePath: join(dir, "link.db") }), { client: mockClient(world()), settings: settings() });
      expect(get(r, "DATABASE_PATH").message).toContain("symlink");
      const ok = await runPreflight(cfgOk({ databasePath: join(dir, "real.db") }), { client: mockClient(world()), settings: settings() });
      expect(get(ok, "DATABASE_PATH").status).toBe("pass");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("settingsFromEnv and fundNeeds", () => {
  it("defaults merchant expectations to the recorded deployment and parses amounts", () => {
    const s = settingsFromEnv({ PAYER_ADDRESS: payer.address, MIN_RELAYER_WBT: "2", PLANNED_PAYER_USDT: "0.5", WEBHOOK_URLS: "https://a.example.com/x, https://b.example.com/y", INSTANCE_COUNT: "1", PORT: "8787", PUBLIC_URL: "https://r.example.com" });
    expect(Object.keys(s.expectedMerchants)).toContain(Object.values(getQualifyingDeployment().merchants!)[0]!.merchantId.toLowerCase());
    expect(s.minRelayerWei).toBe(2n * 10n ** 18n);
    expect(s.plannedPayerUsdt).toBe(500_000n);
    expect(s.urls).toHaveLength(2);
    expect(s.inputErrors).toEqual([]);
  });
  it("records invalid amounts as input errors instead of throwing", () => {
    expect(settingsFromEnv({ MIN_RELAYER_WBT: "-1" }).inputErrors.join()).toContain("MIN_RELAYER_WBT");
    expect(settingsFromEnv({ PLANNED_PAYER_USDT: "1e3" }).inputErrors.join()).toContain("PLANNED_PAYER_USDT");
  });
  it("fundNeeds reports shortfalls per wallet and never sends", async () => {
    const client = mockClient(world({ wbt: { [RELAYER.toLowerCase()]: 1n }, usdt: { [payer.address.toLowerCase()]: 5_000_000n } }));
    const sent: string[] = [];
    (client as unknown as Record<string, unknown>).sendRawTransaction = () => sent.push("x");
    const needs = await fundNeeds(cfgOk(), { client, settings: settings() });
    expect(needs.map((n) => [n.wallet, n.asset, n.short])).toEqual([["relayer", "WBT", true], ["payer", "USDT", false], ["refund signer", "USDT", true]]);
    expect(sent).toEqual([]);
    expect(JSON.stringify(needs)).not.toContain(cfgOk().relayerKey);
  });
});
