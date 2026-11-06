import {
  createPublicClient,
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
  sendPay(args: PayArgs, gas: bigint, gasPrice: bigint): Promise<Hex>;
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

export function makeChain(cfg: { rpcUrl: string; chainId: number; router: Hex; relayerKey: Hex }): ChainPort {
  const chain = defineChain({
    id: cfg.chainId,
    name: "Whitechain Sepolia",
    nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const account: PrivateKeyAccount = privateKeyToAccount(cfg.relayerKey);
  const pub: PublicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
  const wallet: WalletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  const nonces = new NonceManager(() => pub.getTransactionCount({ address: account.address, blockTag: "pending" }));
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
    sendPay(a, gas, gasPrice) {
      return nonces.run((nonce) =>
        wallet.writeContract({
          chain,
          account,
          address: router,
          abi: paymentRouterAbi,
          functionName: "pay",
          args: argList(a),
          gas,
          gasPrice,
          nonce,
        }),
      );
    },
    async waitForReceipt(hash) {
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
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
