// Read-only on-chain and service check to run before a demo or recording. Sends NO transaction, spends nothing.
//   node --env-file=<gitignored env> deploy/demo-check.mjs
// Needs RPC_URL and the keys of the demo wallets (only addresses are derived and printed, never keys).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, formatEther, formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dep = JSON.parse(readFileSync(resolve(root, "contracts/deployments.json"), "utf8"))["1874"];
const merchant = Object.values(dep.merchants)[0];
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(1); } return v; };
const addr = (k) => privateKeyToAccount(need(k).startsWith("0x") ? need(k) : "0x" + need(k)).address;

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`); if (!ok) failed += 1; };
const info = (name, detail) => console.log(`INFO  ${name}: ${detail}`);

const client = createPublicClient({ transport: http(need("RPC_URL")) });
const routerAbi = parseAbi([
  "function token() view returns (address)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function isRelayer(address) view returns (bool)",
  "function merchants(bytes32) view returns (address payout, address refundSigner, uint256 maxRelayFee)",
  "function PAY_TAG() view returns (bytes32)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function name() view returns (string)", "function DOMAIN_SEPARATOR() view returns (bytes32)"]);
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });

const wallets = {
  relayer: addr("RELAYER_PRIVATE_KEY"),
  payer: addr("PAYER_PRIVATE_KEY"),
  refundSigner: addr("REFUND_SIGNER_PRIVATE_KEY"),
  payout: addr("MERCHANT_PAYOUT_PRIVATE_KEY"),
};

// ---- chain and contracts
check("RPC is Whitechain Sepolia (chain id 1874)", (await client.getChainId()) === 1874);
const head = await client.getBlockNumber();
info("head block", String(head));
check("deployments.json marks this deployment as the qualifying one", dep.qualifying === true && dep.verified === true);
check("router has code on chain", (await client.getCode({ address: dep.router }))?.length > 2);
check("router.token() is the official test USDT", getAddress(await read(dep.router, routerAbi, "token")) === getAddress(dep.token), dep.token);
check("router is not paused", (await read(dep.router, routerAbi, "paused")) === false);
check("router owner matches the record", getAddress(await read(dep.router, routerAbi, "owner")) === getAddress(dep.owner));
check("relayer wallet is allow-listed on the router", (await read(dep.router, routerAbi, "isRelayer", [wallets.relayer])) === true, wallets.relayer);
const reg = await read(dep.router, routerAbi, "merchants", [merchant.merchantId]);
check("demo merchant payout on chain equals the one in deployments.json and .env", getAddress(reg[0]) === getAddress(merchant.payout) && getAddress(reg[0]) === getAddress(process.env.MERCHANT_PAYOUT_ADDRESS ?? wallets.payout), reg[0]);
check("demo merchant refund signer on chain equals the refund signer wallet", getAddress(reg[1]) === getAddress(wallets.refundSigner), reg[1]);
info("relay fee cap", `${formatUnits(reg[2], 6)} USDT`);

// ---- official token
check("token is the official test USDT: 6 decimals, name Tether USD", (await read(dep.token, erc20, "decimals")) === 6 && (await read(dep.token, erc20, "name")) === "Tether USD");

// ---- explorer verification
try {
  const r = await fetch(`https://explorer.testnet.whitechain.io/api/v2/smart-contracts/${dep.router}`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  check("router source is verified on the explorer", j.is_verified === true || j.is_fully_verified === true, j.name ?? "");
} catch (e) {
  check("router source is verified on the explorer", false, "explorer not reachable");
}

// ---- balances the demo needs
const bal = async (a) => ({ wbt: await client.getBalance({ address: a }), usdt: await read(dep.token, erc20, "balanceOf", [a]) });
const b = Object.fromEntries(await Promise.all(Object.entries(wallets).map(async ([k, a]) => [k, await bal(a)])));
for (const [k, a] of Object.entries(wallets)) info(`${k} ${a}`, `${formatEther(b[k].wbt)} WBT, ${formatUnits(b[k].usdt, 6)} USDT`);
check("relayer has WBT to pay gas (at least 0.05)", b.relayer.wbt >= 50_000_000_000_000_000n, `${formatEther(b.relayer.wbt)} WBT`);
check("payer holds test USDT for the demo (at least 5)", b.payer.usdt >= 5_000_000n, `${formatUnits(b.payer.usdt, 6)} USDT`);
check("payer cannot pay gas itself (balance below one transfer)", b.payer.wbt < 21000n * (await client.getGasPrice()), `${b.payer.wbt} wei`);
check("refund signer holds test USDT to fund refunds (at least 5)", b.refundSigner.usdt >= 5_000_000n, `${formatUnits(b.refundSigner.usdt, 6)} USDT`);
check("router holds no stray funds", (await read(dep.token, erc20, "balanceOf", [dep.router])) === 0n);

// ---- running services
const get = async (url, init) => { try { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) }); return { status: r.status, body: await r.text() }; } catch { return { status: 0, body: "" }; } };
const rel = await get("http://127.0.0.1:8790/v1/health");
check("relayer is up and on the qualifying router", rel.status === 200 && JSON.parse(rel.body).router?.toLowerCase() === dep.router.toLowerCase());
const led = await get("http://127.0.0.1:8788/v1/health");
const ledger = led.status === 200 ? JSON.parse(led.body) : {};
// Blocks are about a second apart and the indexer polls every 5 s, so a lag of a few blocks is normal.
check("ledger indexer is healthy and within 30 blocks of the chain head", ledger.ok === true && ledger.head - ledger.indexedThrough <= 30, `indexed through ${ledger.indexedThrough}, head ${ledger.head}`);
check("paid API answers 402 with an x402 challenge", (await get("http://127.0.0.1:8791/v1/quote")).status === 402);
check("store web page is up", (await get("http://localhost:5173/")).status === 200);
check("merchant dashboard page is up", (await get("http://localhost:5174/")).status === 200);
const ord = await get("http://127.0.0.1:8790/v1/orders", { headers: { authorization: `Bearer ${need("MERCHANT_API_KEY")}` } });
check("merchant API key works on the relayer", ord.status === 200, ord.status === 200 ? `${(JSON.parse(ord.body).orders ?? JSON.parse(ord.body)).length} orders` : String(ord.status));

console.log(failed ? `\n${failed} check(s) failed` : "\nAll demo checks passed");
process.exit(failed ? 1 : 0);
