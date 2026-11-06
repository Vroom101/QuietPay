import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { buildCheckoutAuthorization, type Order } from "@quietpay/shared";
import type { ChainPort, MerchantRegistry, PayArgs, SignedTx, TxReceipt, RefundArgs, OrderReceipt, PreparedTx } from "../src/chain.js";
import type { Config } from "../src/config.js";
import { Db } from "../src/db.js";
import { RelayerService } from "../src/service.js";

export const MERCHANT_ID = ("0x" + "01".repeat(32)) as Hex;
export const PAYOUT = "0x2222222222222222222222222222222222222222" as Hex;
export const ROUTER = "0x1111111111111111111111111111111111111111" as Hex;
export const USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" as Hex;
export const PAYER_KEY = ("0x" + "a1".repeat(32)) as Hex;
export const REFUND_KEY = ("0x" + "d4".repeat(32)) as Hex;
export const refundSigner = privateKeyToAccount(REFUND_KEY);
export const payer = privateKeyToAccount(PAYER_KEY);

export class FakeChain implements ChainPort {
  relayerAddress = "0x4444444444444444444444444444444444444444" as Hex;
  merchant: MerchantRegistry = { payout: PAYOUT, refundSigner: refundSigner.address, maxRelayFee: 100_000n };
  paused = false;
  settledOnChain = false;
  simulateFails = false;
  gasPrice = 1_000_000_000n; // 1 gwei
  gas = 150_000n;
  receiptStatus: "success" | "reverted" = "success";
  holdReceipt = false;
  /** Pay calls the node accepted (one entry per distinct tx, however often its bytes are re-sent). */
  sent: PayArgs[] = [];
  /** Every tx signed (accepted or not). */
  signed: SignedTx[] = [];
  simulations = 0;
  /**
   * How sendRawTx behaves: "ok"; "reject" (throws, the node never saw the tx); "accept-then-throw" (the
   * node accepted it but the client errored, e.g. a timeout); "hang" (never returns: a crash mid-send).
   */
  sendMode: "ok" | "reject" | "accept-then-throw" | "hang" = "ok";
  sendCalls = 0;
  /** Hashes the node knows (mempool or mined). */
  known = new Set<Hex>();
  /** Per-hash receipt overrides. */
  receipts = new Map<Hex, TxReceipt>();
  nextNonce = 0;
  confirmedNonce = 0;
  resyncs = 0;
  /** Zero-value self-transfers signed to fill or cancel a nonce (signCancel). */
  cancels: (SignedTx & { gasPrice: bigint })[] = [];
  private byRaw = new Map<Hex, { hash: Hex; args?: PayArgs; nonce: number }>();
  private resolveReceipt: ((r: TxReceipt) => void) | null = null;

  async getMerchant() {
    return this.merchant;
  }
  async isPaused() {
    return this.paused;
  }
  async isSettled() {
    return this.settledOnChain;
  }
  async simulatePay(_args?: PayArgs) {
    this.simulations += 1;
    if (this.simulateFails) throw new Error("execution reverted: invalid signature");
    return this.gas;
  }
  refundBalance = 1_000_000_000n;
  balance = 10n ** 18n;
  receiptFails = false;
  broadcastFails = false;
  orderReceipts = new Map<string, OrderReceipt>();
  refundPrepared: { args: RefundArgs; tx: PreparedTx }[] = [];
  prepared: { args: PayArgs; tx: PreparedTx }[] = [];
  async getOrderReceipt(_merchant: Hex, orderId: Hex): Promise<OrderReceipt> {
    return this.orderReceipts.get(orderId) ?? { payer: payer.address, value: 25000000n, refunded: 0n, refundCount: 0n, settled: true };
  }
  async getBalance() { return this.balance; }
  async getTokenBalance() { return this.refundBalance; }
  async authorizationUsed(_payer?: Hex, _nonce?: Hex) { return false; }
  async findExternalSettlement(_args?: unknown) { return { kind: "none" } as const; }
  async simulateTransfer() { throw new Error("Configure a transfer fake for x402 tests"); return 0n; }
  async prepareTransfer(): Promise<PreparedTx> { throw new Error("Configure a transfer fake for x402 tests"); }
  async simulateRefund() { if (this.simulateFails) throw new Error("refund simulation failed"); return this.gas; }
  async prepareRefund(args: RefundArgs, gas: bigint, gasPrice: bigint, nonce?: number): Promise<PreparedTx> {
    const hash = ("0x" + (100000 + this.refundPrepared.length).toString(16).padStart(64,"0")) as Hex;
    const tx = { hash, raw: hash, nonce: nonce ?? this.nextNonce++, gas, gasPrice };
    this.refundPrepared.push({ args, tx }); return tx;
  }
  async preparePay(args: PayArgs, gas: bigint, gasPrice: bigint): Promise<PreparedTx> {
    return { ...await this.signPay(args), gas, gasPrice };
  }
  async broadcast(raw: Hex): Promise<Hex> {
    if (this.broadcastFails) throw new Error("uncertain broadcast");
    const refund = this.refundPrepared.find(p => p.tx.raw === raw);
    if (refund) { this.known.add(refund.tx.hash); return refund.tx.hash; }
    return this.sendRawTx(raw);
  }
  async getGasPrice() {
    return this.gasPrice;
  }
  async signPay(args: PayArgs): Promise<SignedTx> {
    const nonce = this.nextNonce++;
    const i = this.signed.length + 1;
    const hash = ("0x" + i.toString(16).padStart(64, "0")) as Hex;
    const raw = ("0xf0" + i.toString(16).padStart(8, "0")) as Hex;
    this.byRaw.set(raw, { hash, args, nonce });
    const s = { hash, raw, nonce };
    this.signed.push(s);
    return s;
  }
  async signCancel(nonce: number, gasPrice: bigint): Promise<SignedTx> {
    const i = this.cancels.length + 1;
    const hash = ("0xcc" + i.toString(16).padStart(62, "0")) as Hex;
    const raw = ("0xcc" + i.toString(16).padStart(8, "0")) as Hex;
    this.byRaw.set(raw, { hash, nonce });
    const s = { hash, raw, nonce };
    this.cancels.push({ ...s, gasPrice });
    return s;
  }
  async sendRawTx(raw: Hex): Promise<Hex> {
    this.sendCalls += 1;
    const t = this.byRaw.get(raw);
    if (!t) throw new Error("rlp: invalid transaction");
    switch (this.sendMode) {
      case "reject":
        throw new Error("ECONNRESET rpc");
      case "accept-then-throw":
        this.accept(t);
        throw new Error("The request took too long to respond.");
      case "hang":
        return new Promise<Hex>(() => undefined);
      default:
        this.accept(t);
        return t.hash;
    }
  }
  private accept(t: { hash: Hex; args?: PayArgs }) {
    if (this.known.has(t.hash)) return;
    this.known.add(t.hash);
    if (t.args) this.sent.push(t.args);
  }
  /** The node forgets a tx (evicted from the mempool). */
  drop(hash: Hex) {
    this.known.delete(hash);
  }
  resyncNonce() {
    this.resyncs += 1;
  }
  private receiptFor(hash?: Hex): TxReceipt {
    return (hash && this.receipts.get(hash)) || { status: this.receiptStatus, gasUsed: this.gas, effectiveGasPrice: this.gasPrice, blockNumber: 1n };
  }
  waitForReceipt(hash?: Hex): Promise<TxReceipt> {
    if (this.receiptFails) return Promise.reject(new Error("receipt timeout"));
    // A hash the node never saw times out (a real node would after 120 s).
    if (hash && !this.known.has(hash)) return Promise.reject(new Error("Timed out while waiting for transaction"));
    const r = this.receiptFor(hash);
    if (!this.holdReceipt) return Promise.resolve(r);
    return new Promise((res) => (this.resolveReceipt = () => res(r)));
  }
  async getReceipt(hash?: Hex): Promise<TxReceipt | null> {
    if (this.receiptFails || this.holdReceipt || (hash !== undefined && !this.known.has(hash))) return null;
    return this.receiptFor(hash);
  }
  async hasTransaction(hash: Hex) {
    return this.known.has(hash);
  }
  async getConfirmedNonce() {
    return this.confirmedNonce;
  }
  release() {
    this.resolveReceipt?.({} as TxReceipt);
  }
  head = 100n;
  async getBlockNumber() {
    return this.head;
  }
}

export function makeCfg(over: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://localhost:8545",
    chainId: 1874,
    usdt: USDT,
    router: ROUTER,
    relayerKey: ("0x" + "b2".repeat(32)) as Hex,
    operatorToken: "operator-token-123456",
    apiKeys: new Map([["test-key", MERCHANT_ID]]),
    webhookSecret: "whsec_test_secret_123456",
    allowPrivateWebhooks: false,
    databasePath: ":memory:",
    lossBudgetWei: 50_000_000_000_000_000n, // 0.05 WBT
    maxGasPrice: null,
    maxGasLimit: 500000n, lowBalanceWei: 10n ** 16n, pendingRetrySeconds: 30, maxReplacements: 3,
    payerCap: 100_000_000n, // 100 USDT
    relayFee: 50_000n,
    settleConfirmations: 1,
    rateLimitPerMinute: 1000,
    tokenDomain: { name: "Tether USD", version: "1" },
    explorerBaseUrl: "https://explorer.test",
    port: 0,
    // Production default is 60 (MIN_VALID_SECONDS). Tests default to 0 so the other guards can be
    // exercised in isolation; the minimum window has its own tests with the production value.
    minValidSeconds: 0,
    revertedPayerMinValidSeconds: 120,
    maxRevertsPerDay: 2,
    payerLossSharePercent: 25,
    txMaxAgeSeconds: 1800,
    reconcileIntervalSeconds: 30,
    firstTimePayerLossSharePercent: 5,
    firstTimePayerLossCapPercent: 100,
    maxNewPayersPerIpPerHour: 10,
    trustProxyHops: 0,
    ...over,
  };
}

export function makeEnv(cfgOver: Partial<Config> = {}) {
  const clock = { t: 1_800_000_000 };
  const chain = new FakeChain();
  const db = new Db(":memory:");
  const cfg = makeCfg(cfgOver);
  const svc = new RelayerService({ cfg, db, chain, now: () => clock.t, broadcastRetryMs: 0 });
  return { clock, chain, db, cfg, svc };
}

export async function newOrder(svc: RelayerService, amount = "25000000", extra: { webhookUrl?: string } = {}) {
  return svc.createOrder(MERCHANT_ID, { merchantId: MERCHANT_ID, amount, ...extra });
}

export async function signFor(
  order: Order,
  clockNow: number,
  over: { value?: bigint; validAfter?: number; validBefore?: number; key?: Hex; nonce?: Hex } = {},
) {
  const validAfter = over.validAfter ?? clockNow - 5;
  const validBefore = over.validBefore ?? clockNow + 300;
  const acct = over.key ? privateKeyToAccount(over.key) : payer;
  const td = buildCheckoutAuthorization({
    from: payer.address,
    router: order.checkout.router as Hex,
    value: over.value ?? BigInt(order.amount),
    nonce: (over.nonce ?? order.checkout.nonce) as Hex,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    chainId: order.checkout.chainId,
    token: order.checkout.token as Hex,
    domainName: order.checkout.domain.name, domainVersion: order.checkout.domain.version,
  });
  const signature = await acct.signTypedData(td);
  return {
    orderId: order.id,
    payer: payer.address,
    validAfter,
    validBefore,
    signature,
  };
}
