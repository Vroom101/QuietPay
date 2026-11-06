import { encodeFunctionData, erc20Abi, parseAbi, parseEventLogs, type Hex, type PublicClient } from "viem";
import { paymentRouterAbi } from "@quietpay/shared";
export interface RefundArgs { merchantId: Hex; orderId: Hex; amount: bigint; validAfter: bigint; validBefore: bigint; signature: Hex }
export interface OrderReceipt { payer: Hex; value: bigint; refunded: bigint; refundCount: bigint; settled: boolean }
export interface PreparedTx { hash: Hex; raw: Hex; nonce: number; gas: bigint; gasPrice: bigint }
export interface TransferArgs { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex; signature: Hex }
export interface ChainExtensions {
  getOrderReceipt(merchantId: Hex, orderId: Hex): Promise<OrderReceipt>;
  getTokenBalance(address: Hex): Promise<bigint>;
  simulateRefund(args: RefundArgs): Promise<bigint>;
  prepareRefund(args: RefundArgs, gas: bigint, gasPrice: bigint, nonce?: number): Promise<PreparedTx>;
  authorizationUsed(payer: Hex, nonce: Hex): Promise<boolean>;
  simulateTransfer(args: TransferArgs): Promise<bigint>;
  prepareTransfer(args: TransferArgs, gas: bigint, gasPrice: bigint, nonce?: number): Promise<PreparedTx>;
  getBalance(): Promise<bigint>;
  broadcast(raw: Hex): Promise<Hex>;
}
export const receiptTransfers = (logs: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>["logs"]) =>
  parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs, strict: true })
    .map(l => ({ token: l.address, from: l.args.from, to: l.args.to, value: l.args.value, logIndex: l.logIndex }));

export function chainExtensions(pub: PublicClient, router: Hex, account: Hex,
  prepare: (data: Hex, to: Hex, gas: bigint, price: bigint, nonce?: number) => Promise<PreparedTx>): ChainExtensions {
  const refundArgs = (a: RefundArgs) => [a.merchantId, a.orderId, a.amount, a.validAfter, a.validBefore, a.signature] as const;
  const tokenAbi = parseAbi([
    "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
    "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ]);
  const tokenAddress = () => pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "token" });
  const transferArgs = (a: TransferArgs) => {
    let v = parseInt(a.signature.slice(-2), 16); if (v < 27) v += 27;
    return [a.from,a.to,a.value,a.validAfter,a.validBefore,a.nonce,v,a.signature.slice(0,66) as Hex,("0x"+a.signature.slice(66,130)) as Hex] as const;
  };
  return {
    async getOrderReceipt(merchantId, orderId) {
      const head = await pub.getBlockNumber({ cacheTime: 0 });
      const r = await pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "receipts", args: [merchantId, orderId], blockNumber: head > 0n ? head - 1n : 0n });
      return { payer: r.payer, value: r.value, refunded: r.totalRefunded, refundCount: BigInt(r.refundCount), settled: r.settled };
    },
    async getTokenBalance(address) { return pub.readContract({ address: await tokenAddress(), abi: tokenAbi, functionName: "balanceOf", args: [address] }); },
    async simulateRefund(a) {
      await pub.simulateContract({ address: router, abi: paymentRouterAbi, functionName: "refund", args: refundArgs(a), account, blockTag: "pending" });
      return pub.estimateContractGas({ address: router, abi: paymentRouterAbi, functionName: "refund", args: refundArgs(a), account, blockTag: "pending" });
    },
    prepareRefund: (a,gas,price,nonce) => prepare(encodeFunctionData({ abi: paymentRouterAbi, functionName: "refund", args: refundArgs(a) }),router,gas,price,nonce),
    async authorizationUsed(payer,nonce) { return pub.readContract({ address: await tokenAddress(), abi: tokenAbi, functionName: "authorizationState", args: [payer,nonce] }); },
    async simulateTransfer(a) {
      const address = await tokenAddress();
      await pub.simulateContract({ address, abi: tokenAbi, functionName: "transferWithAuthorization", args: transferArgs(a), account, blockTag: "pending" });
      return pub.estimateContractGas({ address, abi: tokenAbi, functionName: "transferWithAuthorization", args: transferArgs(a), account, blockTag: "pending" });
    },
    async prepareTransfer(a,gas,price,nonce) { return prepare(encodeFunctionData({ abi: tokenAbi, functionName: "transferWithAuthorization", args: transferArgs(a) }),await tokenAddress(),gas,price,nonce); },
    getBalance: () => pub.getBalance({ address: account }),
    broadcast: raw => pub.sendRawTransaction({ serializedTransaction: raw }),
  };
}
