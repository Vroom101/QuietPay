// Real testnet refund through PaymentRouter.refund, submitted by the relayer wallet.
// The relayer HTTP endpoints for refunds are not built yet (B), so this talks to the chain directly.
// Usage (local shell, from packages/shared):
//   RPC_URL=... ROUTER_ADDRESS=0x.. USDT_ADDRESS=0x.. MERCHANT_ID=0x.. ORDER_ID=0x.. AMOUNT=2000000 \
//   REFUND_SIGNER_PRIVATE_KEY=0x.. RELAYER_PRIVATE_KEY=0x.. \
//   npx tsx scripts/first-refund.mjs
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildRefundAuthorization, computeRefundNonce, paymentRouterAbi } from "@quietpay/shared";

const e = process.env;
for (const k of ["RPC_URL", "ROUTER_ADDRESS", "USDT_ADDRESS", "MERCHANT_ID", "ORDER_ID", "AMOUNT", "REFUND_SIGNER_PRIVATE_KEY", "RELAYER_PRIVATE_KEY"]) {
  if (!e[k]) throw new Error(`Set ${k}`);
}
const chain = defineChain({ id: 1874, name: "Whitechain Sepolia", nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, rpcUrls: { default: { http: [e.RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(e.RPC_URL) });
const relayer = privateKeyToAccount(e.RELAYER_PRIVATE_KEY);
const signer = privateKeyToAccount(e.REFUND_SIGNER_PRIVATE_KEY);
const wallet = createWalletClient({ account: relayer, chain, transport: http(e.RPC_URL) });
const router = e.ROUTER_ADDRESS;
const amount = BigInt(e.AMOUNT);

const receipt = await pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "receipts", args: [e.MERCHANT_ID, e.ORDER_ID] });
if (!receipt.settled) throw new Error("order has no settled receipt");
const index = BigInt(receipt.refundCount);
const nonce = computeRefundNonce({ merchantId: e.MERCHANT_ID, orderId: e.ORDER_ID, payer: receipt.payer, amount, refundIndex: index });

const now = Math.floor(Date.now() / 1000);
const validAfter = now - 5;
const validBefore = now + 300;
const signature = await signer.signTypedData(
  buildRefundAuthorization({
    refundSigner: signer.address,
    router,
    amount,
    nonce,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    chainId: 1874,
    token: e.USDT_ADDRESS,
  }),
);
await pub.simulateContract({ address: router, abi: paymentRouterAbi, functionName: "refund", args: [e.MERCHANT_ID, e.ORDER_ID, amount, BigInt(validAfter), BigInt(validBefore), signature], account: relayer });
const hash = await wallet.writeContract({ address: router, abi: paymentRouterAbi, functionName: "refund", args: [e.MERCHANT_ID, e.ORDER_ID, amount, BigInt(validAfter), BigInt(validBefore), signature] });
const r = await pub.waitForTransactionReceipt({ hash });
console.log(r.status === "success" ? "REFUNDED" : "FAILED", `${(e.EXPLORER_BASE_URL ?? "").replace(/\/$/, "")}/tx/${hash}`, "refundIndex", index.toString());
