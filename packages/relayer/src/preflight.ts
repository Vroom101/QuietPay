import { createPublicClient, http, parseAbi, formatUnits } from "viem";
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
  const [token, allowed, paused, refundTag, decimals] = await Promise.all([
    client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "token" }),
    client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "isRelayer", args: [relayer] }),
    client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "paused" }),
    client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "REFUND_TAG" }),
    client.readContract({ address: cfg.usdt, abi: parseAbi(["function decimals() view returns (uint8)"]), functionName: "decimals" }),
  ]);
  if (token.toLowerCase() !== cfg.usdt.toLowerCase()) throw new Error("Router token does not match USDT_ADDRESS.");
  if (refundTag !== REFUND_TAG) throw new Error("Router does not support the expected refund authorization version.");
  if (!allowed) throw new Error("Relayer address is not allowlisted on the router.");
  if (decimals !== 6) throw new Error("Configured token must use six decimals.");
  for (const merchantId of new Set(cfg.apiKeys.values())) {
    const [payout] = await client.readContract({ address: cfg.router, abi: paymentRouterAbi, functionName: "merchants", args: [merchantId] });
    if (/^0x0{40}$/i.test(payout)) throw new Error(`Merchant ${merchantId} is not registered.`);
  }
  if (balance === 0n) throw new Error("Relayer has no WBT for gas. Fund its public address before starting.");
  return { ok: true, chainId, router: cfg.router, token: cfg.usdt, relayer,
    balanceWbt: formatUnits(balance, 18), lowBalance: balance < cfg.lowBalanceWei, paused };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await preflight(loadConfig()))); }
  catch (e) { console.error("Preflight failed:", (e as Error).message); process.exitCode = 1; }
}
