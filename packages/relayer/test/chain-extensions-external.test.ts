import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, parseAbi, type Hex, type PublicClient } from "viem";
import { EXTERNAL_LOOKBACK_BLOCKS, chainExtensions, type TransferArgs } from "../src/chain-extensions.js";
import { MERCHANT_ID, ROUTER, payer } from "./helpers.js";

// findExternalSettlement and the thin pass-through methods, against a scripted public client.
const TOKEN = ("0x" + "77".repeat(20)) as Hex;
const FROM = payer.address as Hex;
const TO = ("0x" + "33".repeat(20)) as Hex;
const NONCE = ("0x" + "0a".repeat(32)) as Hex;
const R = ("0x" + "11".repeat(32)) as Hex;
const S = ("0x" + "22".repeat(32)) as Hex;
const SIG = ("0x" + "11".repeat(32) + "22".repeat(32) + "1b") as Hex;
const authAbi = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function balanceOf(address) view returns (uint256)",
]);
const ARGS: TransferArgs = { from: FROM, to: TO, value: 10_000n, validAfter: 0n, validBefore: 9_999_999_999n, nonce: NONCE, signature: SIG };
const callData = (over: Partial<{ from: Hex; to: Hex; value: bigint; nonce: Hex }> = {}) =>
  encodeFunctionData({
    abi: authAbi,
    functionName: "transferWithAuthorization",
    args: [over.from ?? FROM, over.to ?? TO, over.value ?? 10_000n, 0n, 9_999_999_999n, over.nonce ?? NONCE, 27, R, S],
  });
const HASH = ("0x" + "ab".repeat(32)) as Hex;
const log = (over: Record<string, unknown> = {}) => ({ args: { value: 10_000n }, removed: false, transactionHash: HASH, blockNumber: 90n, logIndex: 3, ...over });

type Script = {
  head?: bigint;
  canceled?: unknown[] | Error;
  transfers?: unknown[];
  tx?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
};
function scripted(o: Script) {
  const getLogs = vi.fn(async (q: { event: { name: string } }) => {
    if (q.event.name === "AuthorizationCanceled") {
      if (o.canceled instanceof Error) throw o.canceled;
      return o.canceled ?? [];
    }
    return o.transfers ?? [];
  });
  const getTransaction = vi.fn(async (_q: { hash: Hex }) => ({ to: TOKEN, input: callData(), ...o.tx }));
  const pub = {
    readContract: vi.fn(async () => TOKEN),
    getBlockNumber: vi.fn(async () => o.head ?? 100n),
    getLogs,
    getTransaction,
    getTransactionReceipt: vi.fn(async () => ({ status: "success", ...o.receipt })),
  } as unknown as PublicClient;
  return { pub, getLogs, getTransaction, port: chainExtensions(pub, ROUTER, payer.address, vi.fn()) };
}

describe("findExternalSettlement", () => {
  it("binds a plain transferWithAuthorization to the token with the same from, to, value and nonce", async () => {
    const { port } = scripted({ transfers: [log()] });
    expect(await port.findExternalSettlement(ARGS)).toEqual({ kind: "matched", hash: HASH, blockNumber: 90n, logIndex: 3, confirmations: 11 });
  });
  it("reports a cancel when the token logged AuthorizationCanceled", async () => {
    const { port } = scripted({ canceled: [{}] });
    expect(await port.findExternalSettlement(ARGS)).toEqual({ kind: "cancelled" });
  });
  it("keeps going when the token cannot answer the cancel query", async () => {
    const { port } = scripted({ canceled: new Error("no such event"), transfers: [log()] });
    expect((await port.findExternalSettlement(ARGS)).kind).toBe("matched");
  });
  it("scans at most the lookback window, or from block 0 on a young chain", async () => {
    const old = scripted({ head: 10_000n });
    await old.port.findExternalSettlement(ARGS);
    expect(old.getLogs.mock.calls[0]![0]).toMatchObject({ fromBlock: 10_000n - EXTERNAL_LOOKBACK_BLOCKS, toBlock: 10_000n });
    const young = scripted({ head: 50n });
    await young.port.findExternalSettlement(ARGS);
    expect(young.getLogs.mock.calls[0]![0]).toMatchObject({ fromBlock: 0n });
  });
  const unknownCases: [string, Script][] = [
    ["no transfer logs at all", { transfers: [] }],
    ["a removed (reorged) log", { transfers: [log({ removed: true })] }],
    ["a log with another value", { transfers: [log({ args: { value: 1n } })] }],
    ["a log without a transaction hash", { transfers: [log({ transactionHash: null })] }],
    ["a reverted transaction", { transfers: [log()], receipt: { status: "reverted" } }],
    ["a transaction to some other contract (forwarder or multicall)", { transfers: [log()], tx: { to: "0x" + "55".repeat(20) } }],
    ["a transaction with no recipient", { transfers: [log()], tx: { to: null } }],
    ["input that is not a token call", { transfers: [log()], tx: { input: "0xdeadbeef" } }],
    ["another token function", { transfers: [log()], tx: { input: encodeFunctionData({ abi: authAbi, functionName: "balanceOf", args: [FROM] }) } }],
    ["another payer", { transfers: [log()], tx: { input: callData({ from: ("0x" + "44".repeat(20)) as Hex }) } }],
    ["another payee", { transfers: [log()], tx: { input: callData({ to: ("0x" + "44".repeat(20)) as Hex }) } }],
    ["another amount inside the call", { transfers: [log()], tx: { input: callData({ value: 9n }) } }],
    ["another nonce", { transfers: [log()], tx: { input: callData({ nonce: ("0x" + "0b".repeat(32)) as Hex }) } }],
  ];
  it.each(unknownCases)("parks as unknown when it finds %s", async (_name, script) => {
    expect(await scripted(script).port.findExternalSettlement(ARGS)).toEqual({ kind: "unknown" });
  });
  it("looks at no more than 20 candidates, newest first", async () => {
    const many = Array.from({ length: 30 }, (_, i) => log({ transactionHash: ("0x" + i.toString(16).padStart(64, "0")) as Hex }));
    const s = scripted({ transfers: many, receipt: { status: "reverted" } });
    await s.port.findExternalSettlement(ARGS);
    expect(s.getTransaction.mock.calls).toHaveLength(20);
    expect(s.getTransaction.mock.calls[0]![0]).toEqual({ hash: (many[29] as { transactionHash: Hex }).transactionHash });
  });
});

describe("chain extension pass-throughs", () => {
  const make = () => {
    const prepare = vi.fn(async (..._a: unknown[]) => ({ hash: HASH, raw: "0x01" as Hex, nonce: 1, gas: 1n, gasPrice: 1n }));
    const pub = {
      readContract: vi.fn(async (q: { functionName: string }) => (q.functionName === "token" ? TOKEN : q.functionName === "authorizationState" ? true : 42n)),
      simulateContract: vi.fn(async () => ({})),
      estimateContractGas: vi.fn(async () => 21_000n),
      getBalance: vi.fn(async () => 7n),
      sendRawTransaction: vi.fn(async () => HASH),
    } as unknown as PublicClient;
    return { pub, prepare, port: chainExtensions(pub, ROUTER, payer.address, prepare) };
  };
  it("simulates a transfer and returns the gas estimate", async () => {
    const { port, pub } = make();
    expect(await port.simulateTransfer(ARGS)).toBe(21_000n);
    expect(pub.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ address: TOKEN, functionName: "transferWithAuthorization", blockTag: "pending" }));
  });
  it("normalises a 0/1 signature recovery byte to 27/28 when preparing the call", async () => {
    const { port, prepare } = make();
    await port.prepareTransfer({ ...ARGS, signature: ("0x" + "11".repeat(32) + "22".repeat(32) + "00") as Hex }, 50_000n, 2n, 5);
    expect(prepare.mock.calls[0]).toEqual([callData(), TOKEN, 50_000n, 2n, 5]);
  });
  it("reads balances, authorization state and the gas balance, and broadcasts raw transactions", async () => {
    const { port } = make();
    expect(await port.getTokenBalance(FROM)).toBe(42n);
    expect(await port.authorizationUsed(FROM, NONCE)).toBe(true);
    expect(await port.getBalance()).toBe(7n);
    expect(await port.broadcast("0x01")).toBe(HASH);
  });
  it("simulates and prepares a refund against the router", async () => {
    const { port, pub, prepare } = make();
    const refund = { merchantId: MERCHANT_ID, orderId: MERCHANT_ID, amount: 1n, validAfter: 0n, validBefore: 9n, signature: SIG };
    expect(await port.simulateRefund(refund)).toBe(21_000n);
    expect(pub.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ address: ROUTER, functionName: "refund" }));
    await port.prepareRefund(refund, 1n, 1n);
    expect(prepare.mock.calls[0]![1]).toBe(ROUTER);
  });
});
