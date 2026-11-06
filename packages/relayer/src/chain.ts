import {
  createPublicClient,
  encodeFunctionData,
  parseAbi,
  parseEventLogs,
  erc20Abi,
  keccak256,
  TransactionReceiptNotFoundError,
  createWalletClient,
  defineChain,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { paymentRouterAbi } from "@quietpay/shared";

export interface PayArgs {
  merchantId: Hex;
  orderId: Hex;
  payer: Hex;
  value: bigint;
  fee: bigint;
  validAfter: bigint;
  validBefore: bigint;
  signature: Hex;
}

export interface RefundArgs {
  merchantId: Hex; orderId: Hex; amount: bigint; validAfter: bigint; validBefore: bigint; signature: Hex;
}
export interface OrderReceipt {
  payer: Hex; value: bigint; refunded: bigint; refundCount: bigint; settled: boolean;
}

export interface MerchantRegistry {
  payout: Hex;
  refundSigner: Hex;
  maxRelayFee: bigint;
}

export interface PreparedTx {
  hash: Hex;
  raw: Hex;
  nonce: number;
  gas: bigint;
  gasPrice: bigint;
}

export interface TransferArgs { from: Hex; to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex; signature: Hex }

export interface TxReceipt {
  transfers?: { token: Hex; from: Hex; to: Hex; value: bigint; logIndex: number }[];
  status: "success" | "reverted";
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: bigint;
}

/** Everything the relayer needs from the chain. Faked in unit tests, viem-backed in production. */
export interface ChainPort {
  readonly relayerAddress: Hex;
  getMerchant(merchantId: Hex): Promise<MerchantRegistry>;
  isPaused(): Promise<boolean>;
  isSettled(merchantId: Hex, orderId: Hex): Promise<boolean>;
  /** Throws on revert. Returns the gas the call would use. */
  simulatePay(args: PayArgs): Promise<bigint>;
  getOrderReceipt(merchantId: Hex, orderId: Hex): Promise<OrderReceipt>;
  getTokenBalance(address: Hex): Promise<bigint>;
  simulateRefund(args: RefundArgs): Promise<bigint>;
  prepareRefund(args: RefundArgs, gas: bigint, gasPrice: bigint, nonce?: number): Promise<PreparedTx>;
  authorizationUsed(payer: Hex, nonce: Hex): Promise<boolean>;
  simulateTransfer(args: TransferArgs): Promise<bigint>;
  prepareTransfer(args: TransferArgs, gas: bigint, gasPrice: bigint, nonce?: number): Promise<PreparedTx>;
  getGasPrice(): Promise<bigint>;
  preparePay(args: PayArgs, gas: bigint, gasPrice: bigint, nonce?: number): Promise<PreparedTx>;
  broadcast(raw: Hex): Promise<Hex>;
  getBalance(): Promise<bigint>;
  getReceipt(hash: Hex): Promise<TxReceipt | null>;
  waitForReceipt(hash: Hex): Promise<TxReceipt>;
  getBlockNumber(): Promise<bigint>;
}

/** Hands out sequential nonces and resyncs from the node after any failed send. */
export class NonceManager {
  private next: number | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly fetchPending: () => Promise<number>) {}

  run<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.next === null) this.next = await this.fetchPending();
      try {
        const out = await fn(this.next);
        this.next += 1;
        return out;
      } catch (e) {
        this.next = null; // resync on next use
        throw e;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export function makeChain(cfg: { rpcUrl: string; chainId: number; router: Hex; relayerKey: Hex; nonceFloor?: () => number }): ChainPort {
  const chain = defineChain({
    id: cfg.chainId,
    name: "Whitechain Sepolia",
    nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const account: PrivateKeyAccount = privateKeyToAccount(cfg.relayerKey);
  const pub: PublicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet: WalletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  const nonces = new NonceManager(async () => Math.max(await pub.getTransactionCount({ address: account.address, blockTag: "pending" }), cfg.nonceFloor?.() ?? 0));
  const router = cfg.router;
  const argList = (a: PayArgs) =>
    [a.merchantId, a.orderId, a.payer, a.value, a.fee, a.validAfter, a.validBefore, a.signature] as const;

  const refundArgs = (a: RefundArgs) => [a.merchantId, a.orderId, a.amount, a.validAfter, a.validBefore, a.signature] as const;
  const prepare = async (data: Hex, gas: bigint, gasPrice: bigint, replacementNonce?: number, destination: Hex = router) => {
    const sign = async (nonce: number): Promise<PreparedTx> => {
      const raw = await wallet.signTransaction({ chain, account, to: destination, type: "legacy", value: 0n, data, gas, gasPrice, nonce });
      return { hash: keccak256(raw), raw, nonce, gas, gasPrice };
    };
    return replacementNonce === undefined ? nonces.run(sign) : sign(replacementNonce);
  };
  const tokenAbi = parseAbi([
    "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
    "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
  ]);
  const tokenAddress = () => pub.readContract({address:router,abi:paymentRouterAbi,functionName:"token"});
  const transferArgs = (a: TransferArgs) => {
    let v = parseInt(a.signature.slice(-2),16); if (v < 27) v += 27;
    return [a.from,a.to,a.value,a.validAfter,a.validBefore,a.nonce,v,a.signature.slice(0,66) as Hex,("0x"+a.signature.slice(66,130)) as Hex] as const;
  };
  const transfers = (receipt: Awaited<ReturnType<typeof pub.getTransactionReceipt>>) => parseEventLogs({abi:erc20Abi,eventName:"Transfer",logs:receipt.logs,strict:true})
    .map(log=>({token:log.address,from:log.args.from,to:log.args.to,value:log.args.value,logIndex:log.logIndex}));
  return {
    relayerAddress: account.address,
    async getMerchant(merchantId) {
      const [payout, refundSigner, maxRelayFee] = (await pub.readContract({
        address: router,
        abi: paymentRouterAbi,
        functionName: "merchants",
        args: [merchantId],
      })) as readonly [Hex, Hex, bigint];
      return { payout, refundSigner, maxRelayFee };
    },
    async isPaused() {
      return (await pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "paused" })) as boolean;
    },
    async isSettled(merchantId, orderId) {
      const r = (await pub.readContract({
        address: router,
        abi: paymentRouterAbi,
        functionName: "receipts",
        args: [merchantId, orderId],
      })) as { settled: boolean };
      return r.settled;
    },
    async simulatePay(a) {
      await pub.simulateContract({ address: router, abi: paymentRouterAbi, functionName: "pay", args: argList(a), account });
      return pub.estimateContractGas({ address: router, abi: paymentRouterAbi, functionName: "pay", args: argList(a), account });
    },
    async authorizationUsed(payer,nonce) {
      return pub.readContract({address:await tokenAddress(),abi:tokenAbi,functionName:"authorizationState",args:[payer,nonce]});
    },
    async simulateTransfer(a) {
      const address=await tokenAddress();
      await pub.simulateContract({address,abi:tokenAbi,functionName:"transferWithAuthorization",args:transferArgs(a),account});
      return pub.estimateContractGas({address,abi:tokenAbi,functionName:"transferWithAuthorization",args:transferArgs(a),account});
    },
    async prepareTransfer(a,gas,gasPrice,nonce) {
      return prepare(encodeFunctionData({abi:tokenAbi,functionName:"transferWithAuthorization",args:transferArgs(a)}),gas,gasPrice,nonce,await tokenAddress());
    },
    getGasPrice: () => pub.getGasPrice(),
    preparePay: (a, gas, gasPrice, nonce) => prepare(encodeFunctionData({ abi: paymentRouterAbi, functionName: "pay", args: argList(a) }), gas, gasPrice, nonce),
    prepareRefund: (a, gas, gasPrice, nonce) => prepare(encodeFunctionData({ abi: paymentRouterAbi, functionName: "refund", args: refundArgs(a) }), gas, gasPrice, nonce),
    async simulateRefund(a) {
      await pub.simulateContract({ address: router, abi: paymentRouterAbi, functionName: "refund", args: refundArgs(a), account });
      return pub.estimateContractGas({ address: router, abi: paymentRouterAbi, functionName: "refund", args: refundArgs(a), account });
    },
    async getOrderReceipt(merchantId, orderId) {
      const head = await pub.getBlockNumber({ cacheTime: 0 });
      return pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "receipts", args: [merchantId, orderId], blockNumber: head > 0n ? head - 1n : 0n }) as Promise<OrderReceipt>;
    },
    async getTokenBalance(address) {
      const token = await pub.readContract({ address: router, abi: paymentRouterAbi, functionName: "token" });
      return pub.readContract({ address: token, abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [address] });
    },
    broadcast: (raw) => pub.sendRawTransaction({ serializedTransaction: raw }),
    getBalance: () => pub.getBalance({ address: account.address }),
    async getReceipt(hash) {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        if (await pub.getBlockNumber({ cacheTime: 0 }) < r.blockNumber + 1n) return null;
        return { status: r.status, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, blockNumber: r.blockNumber, transfers: transfers(r) };
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
    async waitForReceipt(hash) {
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 15_000, confirmations: 2, checkReplacement: false });
      return {
        status: r.status,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        blockNumber: r.blockNumber,
        transfers: transfers(r),
      };
    },
    getBlockNumber: () => pub.getBlockNumber(),
  };
}
