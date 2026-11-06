import { beforeEach, describe, expect, it, vi } from "vitest";
const client = vi.hoisted(() => ({ getChainId: vi.fn(), getCode: vi.fn(), getBalance: vi.fn(), readContract: vi.fn() }));
vi.mock("viem", async importOriginal => ({ ...await importOriginal<typeof import("viem")>(), createPublicClient: () => client }));
import { preflight } from "../src/preflight.js";
import { REFUND_TAG } from "@quietpay/shared";
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
    return [PAYOUT, PAYOUT, 100_000n];
  });
});

describe("read-only deployment preflight", () => {
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
