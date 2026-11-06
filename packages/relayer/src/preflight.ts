import { createPublicClient, http, parseAbi, formatUnits, hashDomain } from "viem";
import { paymentRouterAbi, REFUND_TAG } from "@quietpay/shared";
import { privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";

/** Read-only checks; never signs or broadcasts a transaction. */
export async function preflight(cfg: Config) {
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const relayer = privateKeyToAccount(cfg.relayerKey).address;
  const [chainId, routerCode, tokenCode, balance] = await Promise.all([
    client.getChainId(), client.getCode({ address: cfg.router }),
    client.getCode({ address: cfg.usdt }), client.getBalance({ address: relayer }),
  ]);
  if (chainId !== cfg.chainId) throw new Error("RPC chain ID does not match CHAIN_ID.");
  if (!routerCode || routerCode === "0x") throw new Error("ROUTER_ADDRESS has no deployed code.");
  if (!tokenCode || tokenCode === "0x") throw new Error("USDT_ADDRESS has no deployed code.");
  const [token, allowed, paused, refundTag, decimals, separator] = await Promise.all([
    client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "token" }),
    client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "isRelayer", args: [relayer] }),
    client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "paused" }),
    client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "REFUND_TAG" }),
    client.readContract({ address: cfg.usdt, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" }),
    client.readContract({ address: cfg.usdt, abi: parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)"]), functionName: "DOMAIN_SEPARATOR" }),
  ]);
  if (token.toLowerCase() !== cfg.usdt.toLowerCase()) throw new Error("Router token does not match USDT_ADDRESS.");
  if (refundTag !== REFUND_TAG) throw new Error("Router does not support the expected refund authorization version.");
  if (!allowed) throw new Error("Relayer address is not allowlisted on the router.");
  const expectedDomain = hashDomain({ types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] }, domain: { ...cfg.tokenDomain, chainId: BigInt(cfg.chainId), verifyingContract: cfg.usdt } });
  if (separator.toLowerCase() !== expectedDomain.toLowerCase()) throw new Error("Token signing domain does not match TOKEN_DOMAIN_NAME/TOKEN_DOMAIN_VERSION.");
  if (decimals !== 6) throw new Error("Configured token must use six decimals.");
  for (const merchantId of new Set(cfg.apiKeys.values())) {
    const [payout] = await client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "merchants", args: [merchantId] });
    if (/^0x0{40}$/i.test(payout)) throw new Error(`Merchant ${merchantId} is not registered.`);
  }
  if (balance === 0n) throw new Error("Relayer has no WBT for gas. Fund its public address before starting.");
  return { ok: true, chainId, router: cfg.router, token: cfg.usdt, relayer,
    balanceWbt: formatUnits(balance, 18), lowBalance: balance < cfg.lowBalanceWei, paused };
}

/** True when this module is the program being run (not merely imported). */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  return !!argv1 && resolve(argv1) === fileURLToPath(moduleUrl);
}

/** CLI wrapper: prints the preflight report as JSON, or the failure message and a non-zero exit code. */
export async function main(): Promise<void> {
  try { console.log(JSON.stringify(await preflight(loadConfig()))); }
  catch (e) { console.error("Preflight failed:", (e as Error).message); process.exitCode = 1; }
}

if (isEntryPoint(process.argv[1], import.meta.url)) await main();
