import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  type Hex,
  type PublicClient,
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
  /**
   * Unix seconds of the block that included the tx. The viem port fills it for reverted receipts (used to
   * tell a payer-caused revert from an Expired revert caused by the relayer delaying the tx). Optional.
   */
  blockTimestamp?: bigint;
}

/** A pay transaction signed locally. Nothing has been sent yet; `nonce` is reserved by the NonceManager. */
export interface SignedTx {
  hash: Hex;
  raw: Hex;
  nonce: number;
}

/** Everything the relayer needs from the chain. Faked in unit tests, viem-backed in production. */
export interface ChainPort {
  readonly relayerAddress: Hex;
  getMerchant(merchantId: Hex): Promise<MerchantRegistry>;
  isPaused(): Promise<boolean>;
  isSettled(merchantId: Hex, orderId: Hex): Promise<boolean>;
  /** Throws on revert. Returns the gas the call would use. Evaluated against the pending block. */
  simulatePay(args: PayArgs): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  /**
   * Signs a pay transaction locally with the next managed nonce and returns its raw bytes and hash.
   * Nothing is broadcast. The nonce stays reserved; call resyncNonce() if the signed tx is abandoned
   * before it could ever have been sent.
   */
  signPay(args: PayArgs, gas: bigint, gasPrice: bigint): Promise<SignedTx>;
  /**
   * Broadcasts a signed raw transaction. Throws on any error, including ambiguous ones (timeouts, resets)
   * where the node may in fact have accepted the tx: callers must look the hash up before assuming it was
   * not sent. Re-sending the same raw bytes is idempotent.
   */
  sendRawTx(raw: Hex): Promise<Hex>;
  /** Forget the cached next nonce; the next signPay refetches the account's pending nonce from the node. */
  resyncNonce(): void;
  /** Waits (bounded) for a receipt. Throws on timeout. */
  waitForReceipt(hash: Hex): Promise<TxReceipt>;
  /** The receipt if the tx is mined, else null. Never waits. */
  getReceipt(hash: Hex): Promise<TxReceipt | null>;
  /** True if the node knows the tx (in its mempool or mined). */
  hasTransaction(hash: Hex): Promise<boolean>;
  /** Number of transactions from the relayer account included in the latest block (its mined nonce). */
  getConfirmedNonce(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  /**
   * Signs (does not send) a zero-value self-transfer at an EXPLICIT nonce, outside the NonceManager: used
   * to fill a nonce whose pay tx never reached the node, or to replace (cancel) a pay tx whose
   * authorization has expired. `gasPrice` must beat the tx it replaces by the node's replacement bump.
   * Optional: without it the relayer can only wait for the nonce to be consumed or time out.
   */
  signCancel?(nonce: number, gasPrice: bigint): Promise<SignedTx>;
}

/** Gas of a plain value transfer (the cancel / gap-filling self-transfer). */
export const CANCEL_GAS = 21_000n;

/**
 * Hands out sequential nonces. A nonce is consumed when `fn` resolves (the tx was signed and handed to
 * the caller, who must then either persist and track it or call resync()). If `fn` throws, nothing was
 * signed and the manager resyncs from the node on next use.
 */
export class NonceManager {
  private next: number | null = null;
  private stale = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly fetchPending: () => Promise<number>) {}

  run<T>(fn: (nonce: number) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.stale) {
        this.next = null;
        this.stale = false;
      }
      if (this.next === null) this.next = await this.fetchPending();
      const nonce = this.next;
      try {
        const out = await fn(nonce);
        this.next = nonce + 1;
        return out;
      } catch (e) {
        this.next = null; // resync on next use
        throw e;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Refetch from the node before the next nonce is handed out (applied at the start of the next run). */
  resync() {
    this.stale = true;
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
  const nonces = new NonceManager(() => pub.getTransactionCount({ address: account.address, blockTag: "pending" }));
  const router = cfg.router;
  const argList = (a: PayArgs) =>
    [a.merchantId, a.orderId, a.payer, a.value, a.fee, a.validAfter, a.validBefore, a.signature] as const;
  const toReceipt = async (r: { status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint; blockNumber: bigint }): Promise<TxReceipt> => {
    const out: TxReceipt = { status: r.status, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, blockNumber: r.blockNumber };
    if (r.status === "reverted") {
      // Only reverts need the block time (revert attribution); a failed lookup just leaves it unknown.
      try {
        out.blockTimestamp = (await pub.getBlock({ blockNumber: r.blockNumber })).timestamp;
      } catch {
        /* unknown */
      }
    }
    return out;
  };

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
      // Both run against the PENDING block, so a payer whose balance is already committed by a tx still in
      // the mempool fails here instead of passing on "latest" and reverting at the relayer's cost. Nodes
      // differ in their default block tag for eth_estimateGas, so it is always explicit.
      await pub.simulateContract({ address: router, abi: paymentRouterAbi, functionName: "pay", args: argList(a), account, blockTag: "pending" });
      return pub.estimateContractGas({ address: router, abi: paymentRouterAbi, functionName: "pay", args: argList(a), account, blockTag: "pending" });
    },
    getGasPrice: () => pub.getGasPrice(),
    signPay(a, gas, gasPrice) {
      return nonces.run(async (nonce) => {
        const data = encodeFunctionData({ abi: paymentRouterAbi, functionName: "pay", args: argList(a) });
        const raw = await account.signTransaction({ type: "legacy", chainId: cfg.chainId, to: router, data, gas, gasPrice, nonce, value: 0n });
        return { hash: keccak256(raw), raw, nonce };
      });
    },
    sendRawTx(raw) {
      return pub.sendRawTransaction({ serializedTransaction: raw });
    },
    resyncNonce() {
      nonces.resync();
    },
    async signCancel(nonce, gasPrice) {
      const raw = await account.signTransaction({ type: "legacy", chainId: cfg.chainId, to: account.address, value: 0n, gas: CANCEL_GAS, gasPrice, nonce });
      return { hash: keccak256(raw), raw, nonce };
    },
    async waitForReceipt(hash) {
      return toReceipt(await pub.waitForTransactionReceipt({ hash, timeout: 120_000 }));
    },
    async getReceipt(hash) {
      try {
        return await toReceipt(await pub.getTransactionReceipt({ hash }));
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
    async hasTransaction(hash) {
      try {
        await pub.getTransaction({ hash });
        return true;
      } catch (e) {
        if (e instanceof TransactionNotFoundError) return false;
        throw e;
      }
    },
    getConfirmedNonce: () => pub.getTransactionCount({ address: account.address, blockTag: "latest" }),
    getBlockNumber: () => pub.getBlockNumber(),
  };
}
