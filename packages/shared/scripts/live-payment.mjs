// One real payment through PaymentRouter.pay, signed by the payer (who must hold ZERO native gas token) and
// submitted by the allowlisted relayer wallet. Uses nonce v2 (the signed fee). On chain 1874 it only accepts the
// qualifying router and the official USDT.
//
// Usage (local shell, from packages/shared):
//   RPC_URL=... ROUTER_ADDRESS=0x.. USDT_ADDRESS=0x.. PAYER_PRIVATE_KEY=0x.. RELAYER_PRIVATE_KEY=0x.. \
//   AMOUNT=1 FEE=0.05 EXPLORER_BASE_URL=https://explorer.testnet.whitechain.io npx tsx scripts/live-payment.mjs
// Optional: CHAIN_ID (default read from the RPC), MERCHANT_SLUG (default demo-store), ORDER_ID, ALLOW_PAYER_GAS=1 (anvil only).
import { createPublicClient, createWalletClient, defineChain, getAddress, http, keccak256, parseAbi, stringToHex, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import {
  assertQualifyingConfig,
  getQualifyingDeployment,
  buildCheckoutAuthorization,
  computePayNonce,
  formatUsdt,
  paymentRouterAbi,
  parseUsdt,
  parseUsdtAllowZero,
  QUALIFYING_CHAIN_ID,
} from "@quietpay/shared";

const e = process.env;
for (const k of ["RPC_URL", "ROUTER_ADDRESS", "USDT_ADDRESS", "PAYER_PRIVATE_KEY", "RELAYER_PRIVATE_KEY"]) if (!e[k]) throw new Error(`Set ${k}`);

const pub0 = createPublicClient({ transport: http(e.RPC_URL) });
// Always the qualifying pair: ask the node (never trust an env override), and accept only the recorded router.
const chainId = await pub0.getChainId();
if (e.CHAIN_ID !== undefined && Number(e.CHAIN_ID) !== QUALIFYING_CHAIN_ID) throw new Error(`Refusing: CHAIN_ID ${e.CHAIN_ID} is not ${QUALIFYING_CHAIN_ID}`);
if (chainId !== QUALIFYING_CHAIN_ID) throw new Error(`Refusing: the node reports chain ${chainId}, not ${QUALIFYING_CHAIN_ID}`);
assertQualifyingConfig({ chainId, tokenAddress: e.USDT_ADDRESS });
if (e.ROUTER_ADDRESS.toLowerCase() !== getQualifyingDeployment().router.toLowerCase()) {
  throw new Error(`Refusing: ROUTER_ADDRESS ${e.ROUTER_ADDRESS} is not the qualifying router ${getQualifyingDeployment().router}`);
}
const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, rpcUrls: { default: { http: [e.RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(e.RPC_URL) });
const router = getAddress(e.ROUTER_ADDRESS);
const usdt = getAddress(e.USDT_ADDRESS);
const payer = privateKeyToAccount(e.PAYER_PRIVATE_KEY);
const relayer = privateKeyToAccount(e.RELAYER_PRIVATE_KEY);
const wallet = createWalletClient({ account: relayer, chain, transport: http(e.RPC_URL) });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const bal = (a) => pub.readContract({ address: usdt, abi: erc20, functionName: "balanceOf", args: [a] });

const value = parseUsdt(e.AMOUNT ?? "1");
const fee = parseUsdtAllowZero(e.FEE ?? "0.05");
if (fee >= value) throw new Error("fee must be below the amount");
const slug = e.MERCHANT_SLUG ?? "demo-store";
const merchantId = keccak256(stringToHex(slug));
const [payout, , maxFee] = await pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "merchants", args: [merchantId] });
if (/^0x0+$/.test(payout)) throw new Error(`merchant ${slug} is not registered on this router`);
if (fee > maxFee) throw new Error(`fee ${formatUsdt(fee)} exceeds the merchant cap ${formatUsdt(maxFee)}`);

// Preconditions: the payer must be a zero-gas wallet that actually holds the token.
const payerWbt = await pub.getBalance({ address: payer.address });
// "Zero gas" means the payer cannot afford even one plain transfer. A few wei of unsendable dust can remain after sweeping.
const minTxCost = 21000n * (await pub.getGasPrice());
if (payerWbt >= minTxCost && e.ALLOW_PAYER_GAS !== "1") throw new Error(`payer holds usable native gas token (${payerWbt} wei, one transfer costs ${minTxCost}); the demo requires a payer that cannot pay gas`);
const payerUsdt = await bal(payer.address);
if (payerUsdt < value) throw new Error(`payer holds ${formatUsdt(payerUsdt)} USDT, needs ${formatUsdt(value)}`);

const before = { payer: payerUsdt, payout: await bal(payout), relayer: await bal(relayer.address), router: await bal(router) };
const orderId = e.ORDER_ID ?? toHex(randomBytes(32));
const nonce = computePayNonce({ merchantId, orderId, payout, value, fee });
const now = Math.floor(Date.now() / 1000);
const validAfter = BigInt(now - 10);
const validBefore = BigInt(now + 300);
const signature = await payer.signTypedData(
  buildCheckoutAuthorization({ from: payer.address, router, value, nonce, validAfter, validBefore, chainId, token: usdt }),
);
const args = [merchantId, orderId, payer.address, value, fee, validAfter, validBefore, signature];

// Simulate first: a revert reason is far easier to read here than on chain.
await pub.simulateContract({ address: router, abi: paymentRouterAbi, functionName: "pay", args, account: relayer });
const hash = await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "pay", args });
const rc = await pub.waitForTransactionReceipt({ hash });
if (rc.status !== "success") throw new Error(`pay reverted on chain: ${hash}`);

const after = { payer: await bal(payer.address), payout: await bal(payout), relayer: await bal(relayer.address), router: await bal(router) };
const receipt = await pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "receipts", args: [merchantId, orderId] });
const checks = {
  receiptSettled: receipt.settled === true,
  payerPaidExactlyPrice: before.payer - after.payer === value,
  merchantGotValueMinusFee: after.payout - before.payout === value - fee,
  relayerGotFee: after.relayer - before.relayer === fee,
  routerHoldsNothing: after.router === before.router,
  payerStillZeroGas: (await pub.getBalance({ address: payer.address })) === payerWbt,
};
const base = (e.EXPLORER_BASE_URL ?? "").replace(/\/$/, "");
console.log(JSON.stringify({
  ok: Object.values(checks).every(Boolean), checks, chainId, router, usdt, merchantId, orderId,
  value: formatUsdt(value), fee: formatUsdt(fee), payer: payer.address, payout, relayer: relayer.address,
  txHash: hash, block: Number(rc.blockNumber), txUrl: base ? `${base}/tx/${hash}` : undefined,
  payerNativeBalance: payerWbt.toString(),
}, null, 2));
if (!Object.values(checks).every(Boolean)) process.exit(2);
