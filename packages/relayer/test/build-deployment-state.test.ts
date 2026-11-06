import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseUnits, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { merchantIdFromSlug, paymentRouterAbi } from "@quietpay/shared";
import { assertPortFree, requireInCi, waitForRpc } from "./anvil-util.js";
import { runPreflight, type PreflightSettings } from "../src/preflight-checks.js";
import { makeCfg } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.CONTRACTS_OUT ?? resolve(here, "../../../contracts/out");
const routerArtifact = resolve(out, "PaymentRouter.sol/PaymentRouter.json");
const usdtArtifact = resolve(out, "MockAuthToken.sol/MockAuthToken.json");
const haveArtifacts = existsSync(routerArtifact) && existsSync(usdtArtifact);
requireInCi(haveArtifacts, "compiled contracts (forge build)");
const hasAnvil = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
requireInCi(hasAnvil, "anvil");

// Standard anvil dev keys (public, test-only).
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const RELAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const OTHER_RELAYER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const PAYOUT = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
const REFUND_SIGNER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" as Address;
const PAYER = "0x00000000000000000000000000000000000ab123" as Address; // fresh address: holds no native token
const PORT = Number(process.env.ANVIL_PORT ?? 8745);
const RPC = `http://127.0.0.1:${PORT}`;
const chainDef = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const MAX_RELAY_FEE = 100_000n;

interface Expected { token: Address; merchantId: Hex; payout: Address; refundSigner: Address; maxRelayFee: bigint; relayer: Address }

/** Read-only: the list of ways the deployment differs from what we expect. Empty means correct. */
async function deploymentProblems(pub: ReturnType<typeof createPublicClient>, router: Address, e: Expected): Promise<string[]> {
  const problems: string[] = [];
  const code = await pub.getCode({ address: router });
  if (!code || code === "0x") return ["router has no bytecode"];
  const read = (functionName: string, args?: unknown[]) => pub.readContract({ address: router, abi: paymentRouterAbi, functionName, args } as never) as Promise<any>;
  if (String(await read("token")).toLowerCase() !== e.token.toLowerCase()) problems.push("router.token differs");
  const [payout, refundSigner, maxRelayFee] = (await read("merchants", [e.merchantId])) as [Address, Address, bigint];
  if (/^0x0{40}$/i.test(payout)) problems.push("merchant not registered");
  else {
    if (payout.toLowerCase() !== e.payout.toLowerCase()) problems.push("merchant payout differs");
    if (refundSigner.toLowerCase() !== e.refundSigner.toLowerCase()) problems.push("merchant refundSigner differs");
    if (maxRelayFee !== e.maxRelayFee) problems.push("merchant maxRelayFee differs");
  }
  if ((await read("isRelayer", [e.relayer])) !== true) problems.push("relayer not allowlisted");
  if ((await read("paused")) !== false) problems.push("router paused");
  return problems;
}

describe.skipIf(!haveArtifacts || !hasAnvil)("W1: deployment state on a local anvil (real PaymentRouter artifact)", () => {
  let anvil: ChildProcess;
  const pub = createPublicClient({ chain: chainDef, transport: http(RPC) });
  const deployer = privateKeyToAccount(DEPLOYER_KEY);
  const wallet = createWalletClient({ account: deployer, chain: chainDef, transport: http(RPC) });
  const relayer = privateKeyToAccount(RELAYER_KEY).address;
  const merchantId = merchantIdFromSlug("demo-store");
  let usdt: Address; let router: Address; let expected: Expected;
  const send = async (hash: Hex) => pub.waitForTransactionReceipt({ hash });
  const load = (p: string) => JSON.parse(readFileSync(p, "utf8")) as { abi: Abi; bytecode: { object: Hex } };

  beforeAll(async () => {
    await assertPortFree(PORT);
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    await waitForRpc(RPC);
    const t = load(usdtArtifact); const r = load(routerArtifact);
    usdt = (await send(await wallet.deployContract({ abi: t.abi, bytecode: t.bytecode.object })))!.contractAddress!;
    router = (await send(await wallet.deployContract({ abi: r.abi, bytecode: r.bytecode.object, args: [usdt, deployer.address] })))!.contractAddress!;
    await send(await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "registerMerchant", args: [merchantId, PAYOUT, REFUND_SIGNER, MAX_RELAY_FEE] }));
    await send(await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "setRelayer", args: [relayer, true] }));
    await send(await wallet.writeContract({ address: usdt, abi: t.abi, functionName: "mint", args: [PAYER, parseUnits("10", 6)] }));
    await send(await wallet.writeContract({ address: usdt, abi: t.abi, functionName: "mint", args: [REFUND_SIGNER, parseUnits("10", 6)] }));
    expected = { token: usdt, merchantId, payout: PAYOUT, refundSigner: REFUND_SIGNER, maxRelayFee: MAX_RELAY_FEE, relayer };
  }, 60_000);
  afterAll(() => { anvil?.kill(); });

  it("a correct deployment has bytecode, the configured token, the registered merchant, an allowlisted relayer and is not paused", async () => {
    expect(await deploymentProblems(pub, router, expected)).toEqual([]);
  });

  it("catches an unregistered merchant", async () => {
    expect(await deploymentProblems(pub, router, { ...expected, merchantId: merchantIdFromSlug("never-registered") })).toEqual(["merchant not registered"]);
  });
  it("catches a wrong payout, refund signer or fee", async () => {
    expect(await deploymentProblems(pub, router, { ...expected, payout: PAYER })).toEqual(["merchant payout differs"]);
    expect(await deploymentProblems(pub, router, { ...expected, refundSigner: PAYER })).toEqual(["merchant refundSigner differs"]);
    expect(await deploymentProblems(pub, router, { ...expected, maxRelayFee: 1n })).toEqual(["merchant maxRelayFee differs"]);
  });
  it("catches a non-allowlisted relayer", async () => {
    expect(await deploymentProblems(pub, router, { ...expected, relayer: privateKeyToAccount(OTHER_RELAYER_KEY).address })).toEqual(["relayer not allowlisted"]);
  });
  it("catches a wrong token and a missing router", async () => {
    expect(await deploymentProblems(pub, router, { ...expected, token: PAYER })).toEqual(["router.token differs"]);
    expect(await deploymentProblems(pub, PAYER, expected)).toEqual(["router has no bytecode"]);
  });

  it("preflight (one anvil run): passes the correct setup, then fails once the router is paused (last, mutates local state)", async () => {
    const settings: PreflightSettings = {
      expectedMerchants: { [merchantId.toLowerCase()]: { payout: PAYOUT, refundSigner: REFUND_SIGNER, maxRelayFee: MAX_RELAY_FEE } },
      payer: PAYER, refundSigner: REFUND_SIGNER, minRelayerWei: parseUnits("1", 18),
      plannedPayerUsdt: parseUnits("1", 6), plannedRefundSignerUsdt: parseUnits("1", 6),
      publicUrl: "https://relayer.example.com", port: "8787", urls: [], instanceCount: "1", inputErrors: [],
    };
    const cfg = makeCfg({
      rpcUrl: RPC, chainId: 31337, usdt, router, relayerKey: RELAYER_KEY,
      apiKeys: new Map([["merchant-api-key-0123456789abcdef", merchantId]]),
      operatorToken: "operator-token-0123456789abcdef", webhookSecret: "webhook-secret-0123456789abcdef",
      databasePath: resolve(here, "build-deployment-state.test.ts"), // an existing regular file, only inspected
    });
    const fs = { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => true, mode: 0o600 }), assertWritable: () => undefined };
    const client = pub as never;
    const ok = await runPreflight(cfg, { client, settings, fs, platform: "linux", nonQualifyingForTests: true });
    expect(ok.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(ok.ok).toBe(true);

    // A payer that can afford a transfer is refused (anvil accounts hold 10000 ETH).
    const funded = await runPreflight(cfg, { client, settings: { ...settings, payer: deployer.address, plannedPayerUsdt: 0n }, fs, platform: "linux", nonQualifyingForTests: true });
    expect(funded.checks.find((c) => c.code === "PAYER_NO_GAS")!.status).toBe("fail");

    await send(await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "pause" }));
    expect(await deploymentProblems(pub, router, expected)).toEqual(["router paused"]);
    const paused = await runPreflight(cfg, { client, settings, fs, platform: "linux", nonQualifyingForTests: true });
    expect(paused.checks.find((c) => c.code === "ROUTER_NOT_PAUSED")!.status).toBe("fail");
    expect(paused.ok).toBe(false);
  }, 60_000);
});
