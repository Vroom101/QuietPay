import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, http, parseAbi, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getQualifyingDeployment, merchantIdFromSlug, paymentRouterAbi, QUALIFYING_USDT } from "@quietpay/shared";
import { AnvilProc, FaultyRpc, killAllTracked, RelayerProc, WebhookSink } from "./procs.js";
import { merchantWebhookSecretFor } from "./webhook-secret.js";
import { addSecret, contractsOut } from "./util.js";

export const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function mint(address to, uint256 amt)",
  "function authorizationState(address, bytes32) view returns (bool)",
]);

// Public anvil dev keys (local chain only).
const ANVIL_KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  relayer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  payout: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  payout2: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
} as const satisfies Record<string, Hex>;

export interface Tenant { slug: string; merchantId: Hex; apiKey: string; payout: Address; refundKey: Hex; refundSigner: Address }

export interface Stack {
  live: boolean;
  chainId: 1874;
  router: Address;
  usdt: Address;
  /** Direct node RPC for the harness's own reads. */
  chainRpc: string;
  pub: PublicClient;
  tmp: string;
  masterSecret: string;
  operatorToken: string;
  relayer: RelayerProc;
  relayerUrl: string;
  relayerAddress: Address;
  sink: WebhookSink;
  proxy?: FaultyRpc;
  anvil?: AnvilProc;
  /** The merchant under test. */
  tenant: Tenant;
  /** A second merchant (local only) for cross-tenant attacks. */
  other?: Tenant;
  newPayer(usdt?: bigint): Promise<{ key: Hex; address: Address }>;
  usdtOf(a: Address): Promise<bigint>;
  wbtOf(a: Address): Promise<bigint>;
  /** Owner-only chain control (local only). */
  owner?: { pause(): Promise<void>; unpause(): Promise<void>; mine(n: number): Promise<void>; startBlock: number };
  restartRelayer(envOverride?: Record<string, string>): Promise<void>;
  webhookSecretOf(t: Tenant): string;
  stop(): Promise<void>;
}

const slots = Array.from({ length: 10 }, (_, i) => `0x${i.toString(16)}` as Hex);

export interface LocalOpts { basePort?: number; relayerEnv?: Record<string, string> }

/**
 * Local stack: anvil with chain id 1874 where the REAL PaymentRouter bytecode sits at the qualifying router
 * address and the mock EIP-3009 token at the official USDT address (so the unmodified relayer, indexer and
 * verifier entries, which refuse any other chain/router/token, run against it).
 */
export async function startLocalStack(o: LocalOpts = {}): Promise<Stack> {
  const base = o.basePort ?? Number(process.env.E2E_PORT_BASE ?? 8825);
  const tmp = mkdtempSync(resolve(tmpdir(), "b-build-w4-e2e-"));
  const dep = getQualifyingDeployment();
  const router = dep.router as Address;
  const usdt = QUALIFYING_USDT as Address;

  const anvil = new AnvilProc(base);
  await anvil.start();
  const rpc = anvil.url;
  const chain = { id: 1874, name: "anvil-1874", nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const call = async (method: string, params: unknown[]) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  const deployer = privateKeyToAccount(ANVIL_KEYS.deployer);
  const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });
  const out = contractsOut();
  const load = (p: string) => JSON.parse(readFileSync(resolve(out, p), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  const tokArt = load("MockAuthToken.sol/MockAuthToken.json");
  const routerArt = load("PaymentRouter.sol/PaymentRouter.json");

  // Deploy normally, then copy runtime code + the constructor-written storage to the qualifying addresses.
  const scratchTok = (await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: tokArt.abi, bytecode: tokArt.bytecode.object }) })).contractAddress!;
  const scratchRouter = (await pub.waitForTransactionReceipt({ hash: await wallet.deployContract({ abi: routerArt.abi, bytecode: routerArt.bytecode.object, args: [usdt, deployer.address] }) })).contractAddress!;
  for (const [from, to] of [[scratchTok, usdt], [scratchRouter, router]] as const) {
    await call("anvil_setCode", [to, await call("eth_getCode", [from, "latest"])]);
    for (const s of slots) await call("anvil_setStorageAt", [to, s, await call("eth_getStorageAt", [from, s, "latest"])]);
  }

  const mk = async (slug: string, payoutKey: Hex): Promise<Tenant> => {
    const refundKey = generatePrivateKey();
    const refundSigner = privateKeyToAccount(refundKey).address;
    const payout = privateKeyToAccount(payoutKey).address;
    const merchantId = merchantIdFromSlug(slug);
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "registerMerchant", args: [merchantId, payout, refundSigner, 100_000n] }) });
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdt, abi: ERC20, functionName: "mint", args: [refundSigner, 1_000_000_000n] }) });
    const apiKey = `e2e-${slug}-${generatePrivateKey().slice(2, 34)}`;
    addSecret(apiKey);
    return { slug, merchantId, apiKey, payout, refundKey, refundSigner };
  };
  const tenant = await mk("demo-store", ANVIL_KEYS.payout);
  const other = await mk("other-store", ANVIL_KEYS.payout2);
  const relayerAcct = privateKeyToAccount(ANVIL_KEYS.relayer);
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "setRelayer", args: [relayerAcct.address, true] }) });

  const proxy = new FaultyRpc(base + 1, rpc);
  await proxy.start();
  const sink = new WebhookSink(base + 3);
  await sink.start();
  const masterSecret = `e2e-master-${generatePrivateKey().slice(2, 30)}`;
  const operatorToken = `e2e-operator-${generatePrivateKey().slice(2, 30)}`;
  addSecret(masterSecret); addSecret(operatorToken);
  const startBlock = Number(await pub.getBlockNumber());

  const relayerEnv: Record<string, string> = {
    RPC_URL: proxy.url, CHAIN_ID: "1874", USDT_ADDRESS: usdt, ROUTER_ADDRESS: router, RELAYER_PRIVATE_KEY: ANVIL_KEYS.relayer,
    OPERATOR_TOKEN: operatorToken, MERCHANT_API_KEYS: `${tenant.apiKey}:${tenant.merchantId},${other.apiKey}:${other.merchantId}`,
    WEBHOOK_SECRET: masterSecret, ALLOW_PRIVATE_WEBHOOKS: "1", DATABASE_PATH: resolve(tmp, "relayer.db"),
    LOSS_BUDGET_WBT_PER_HOUR: "1", RATE_LIMIT_PER_MINUTE: "1000", MAX_NEW_PAYERS_PER_IP_PER_HOUR: "200", PAYER_CAP_USDT: "100000",
    RECONCILE_INTERVAL_SECONDS: "5", PENDING_RETRY_SECONDS: "5", RELAY_FEE_USDT: "0.05",
    EXPLORER_BASE_URL: "https://explorer.testnet.whitechain.io", ...o.relayerEnv,
  };
  const relayer = new RelayerProc({ port: base + 2, env: relayerEnv, logDir: resolve(tmp, "logs"), name: "relayer" });
  mkdirSync(resolve(tmp, "logs"), { recursive: true });
  await relayer.start();

  const stack: Stack = {
    live: false, chainId: 1874, router, usdt, chainRpc: rpc, pub, tmp, masterSecret, operatorToken, relayer, relayerUrl: relayer.url,
    relayerAddress: relayerAcct.address, sink, proxy, anvil, tenant, other,
    async newPayer(amount = 1_000_000_000n) {
      const key = generatePrivateKey();
      const address = privateKeyToAccount(key).address;
      await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdt, abi: ERC20, functionName: "mint", args: [address, amount] }) });
      return { key, address };
    },
    usdtOf: (a) => pub.readContract({ address: usdt, abi: ERC20, functionName: "balanceOf", args: [a] }) as Promise<bigint>,
    wbtOf: (a) => pub.getBalance({ address: a }),
    owner: {
      pause: async () => { await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "pause" }) }); },
      unpause: async () => { await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "unpause" }) }); },
      mine: async (n) => { await call("anvil_mine", [`0x${n.toString(16)}`]); },
      startBlock,
    },
    async restartRelayer(envOverride = {}) {
      relayer.kill();
      await new Promise((r) => setTimeout(r, 300));
      await relayer.start(envOverride);
    },
    webhookSecretOf: (t) => merchantWebhookSecretFor(masterSecret, t.merchantId),
    async stop() {
      relayer.kill(); proxy.stop(); sink.stop(); anvil.stop(); killAllTracked();
    },
  };
  return stack;
}
