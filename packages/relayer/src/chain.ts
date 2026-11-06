import {
  createPublicClient,
  encodeFunctionData,
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

export interface TxReceipt {
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
    getGasPrice: () => pub.getGasPrice(),
    async preparePay(a, gas, gasPrice, replacementNonce) {
      const sign = async (nonce: number): Promise<PreparedTx> => {
        const raw = await wallet.signTransaction({
          chain, account, to: router, type: "legacy", value: 0n,
          data: encodeFunctionData({ abi: paymentRouterAbi, functionName: "pay", args: argList(a) }),
          gas, gasPrice, nonce,
        });
        return { hash: keccak256(raw), raw, nonce, gas, gasPrice };
      };
      return replacementNonce === undefined ? nonces.run(sign) : sign(replacementNonce);
    },
    broadcast: (raw) => pub.sendRawTransaction({ serializedTransaction: raw }),
    getBalance: () => pub.getBalance({ address: account.address }),
    async getReceipt(hash) {
      try {
        const r = await pub.getTransactionReceipt({ hash });
        if (await pub.getBlockNumber() < r.blockNumber + 1n) return null;
        return { status: r.status, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, blockNumber: r.blockNumber };
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
      };
    },
    getBlockNumber: () => pub.getBlockNumber(),
  };
}
