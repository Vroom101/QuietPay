import { beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ getChainId: vi.fn(), getCode: vi.fn(), getBalance: vi.fn(), readContract: vi.fn() }));
vi.mock("viem", async importOriginal => ({ ...await importOriginal<typeof import("viem")>(), createPublicClient: () => client }));
import { preflight, isEntryPoint, main } from "../src/preflight.js";
import { REFUND_TAG } from "@quietpay/shared";
import { hashDomain } from "viem";
import { makeCfg, PAYOUT } from "./helpers.js";

beforeEach(() => {
  client.getChainId.mockResolvedValue(1874);
  client.getCode.mockResolvedValue("0x1234");
  client.getBalance.mockResolvedValue(10n ** 18n);
  client.readContract.mockImplementation(async ({ functionName }) => {
    if (functionName === "REFUND_TAG") return REFUND_TAG;
    if (functionName === "token") return makeCfg().usdt;
    if (functionName === "isRelayer") return true;
    if (functionName === "paused") return false;
    if (functionName === "decimals") return 6;
    if (functionName === "DOMAIN_SEPARATOR") { const cfg = makeCfg(); return hashDomain({ types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] }, domain: { ...cfg.tokenDomain, chainId: BigInt(cfg.chainId), verifyingContract: cfg.usdt } }); }
    return [PAYOUT, PAYOUT, 100_000n];
  });
});

describe("read-only deployment preflight", () => {
  it("rejects a configured domain that differs from the token", async () => {
    await expect(preflight(makeCfg({ tokenDomain: { name: "Wrong token", version: "1" } }))).rejects.toThrow("Token signing domain");
  });
  it("accepts a funded and registered deployment", async () => {
    expect(await preflight(makeCfg())).toMatchObject({ ok: true, chainId: 1874, balanceWbt: "1", paused: false });
  });
  it("rejects an RPC for the wrong chain", async () => {
    client.getChainId.mockResolvedValue(1);
    await expect(preflight(makeCfg())).rejects.toThrow("chain ID");
  });
  it("rejects missing deployed bytecode", async () => {
    client.getCode.mockResolvedValue("0x");
    await expect(preflight(makeCfg())).rejects.toThrow("no deployed code");
  });
  it("rejects an unfunded relayer", async () => {
    client.getBalance.mockResolvedValue(0n);
    await expect(preflight(makeCfg())).rejects.toThrow("no WBT");
  });
  it("rejects a relayer outside the allowlist", async () => {
    const original = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async args => args.functionName === "isRelayer" ? false : original(args));
    await expect(preflight(makeCfg())).rejects.toThrow("not allowlisted");
  });
});

describe("preflight: every remaining refusal", () => {
  const override = (fn: string, value: unknown) => {
    const original = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async args => (args.functionName === fn ? value : original(args)));
  };
  it("rejects a router whose token is not the configured USDT", async () => {
    override("token", "0x" + "99".repeat(20));
    await expect(preflight(makeCfg())).rejects.toThrow("Router token does not match USDT_ADDRESS.");
  });
  it("rejects a router with another refund authorization version", async () => {
    override("REFUND_TAG", "0x" + "00".repeat(32));
    await expect(preflight(makeCfg())).rejects.toThrow("refund authorization version");
  });
  it("rejects a token that does not use six decimals", async () => {
    override("decimals", 18);
    await expect(preflight(makeCfg())).rejects.toThrow("six decimals");
  });
  it("rejects a merchant that is not registered on the router", async () => {
    const original = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(async args => (args.functionName === "merchants" ? ["0x" + "00".repeat(20), "0x" + "00".repeat(20), 0n] : original(args)));
    await expect(preflight(makeCfg())).rejects.toThrow(/is not registered\./);
  });
  it("rejects a router with no code but a token with code, and the reverse", async () => {
    client.getCode.mockResolvedValueOnce(undefined).mockResolvedValueOnce("0x1234");
    await expect(preflight(makeCfg())).rejects.toThrow("ROUTER_ADDRESS has no deployed code.");
    client.getCode.mockReset();
    client.getCode.mockResolvedValueOnce("0x1234").mockResolvedValueOnce("0x");
    await expect(preflight(makeCfg())).rejects.toThrow("USDT_ADDRESS has no deployed code.");
  });
  it("reports a low balance and a paused router without failing", async () => {
    client.getBalance.mockResolvedValue(1n);
    override("paused", true);
    expect(await preflight(makeCfg())).toMatchObject({ ok: true, lowBalance: true, paused: true });
  });
});

describe("preflight CLI wrapper", () => {
  it("isEntryPoint is true only for the module that was started", () => {
    const here = new URL("../src/preflight.ts", import.meta.url);
    expect(isEntryPoint(undefined, here.href)).toBe(false);
    expect(isEntryPoint("", here.href)).toBe(false);
    expect(isEntryPoint(new URL("../src/other.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), here.href)).toBe(false);
    expect(isEntryPoint(decodeURIComponent(here.pathname).replace(/^\/([A-Za-z]:)/, "$1"), here.href)).toBe(true);
  });
  it("main prints a failure message and sets a non-zero exit code when the configuration is missing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) delete process.env[k];
    const code = process.exitCode;
    try {
      await main();
      expect(process.exitCode).toBe(1);
      expect(err).toHaveBeenCalledWith("Preflight failed:", expect.any(String));
    } finally {
      process.exitCode = code;
      Object.assign(process.env, saved);
      err.mockRestore();
    }
  });
});
