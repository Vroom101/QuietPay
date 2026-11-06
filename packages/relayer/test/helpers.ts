import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { buildCheckoutAuthorization, type Order } from "@quietpay/shared";
import type { ChainPort, MerchantRegistry, PayArgs, TxReceipt } from "../src/chain.js";
import type { Config } from "../src/config.js";
import { Db } from "../src/db.js";
import { RelayerService } from "../src/service.js";

export const MERCHANT_ID = ("0x" + "01".repeat(32)) as Hex;
export const PAYOUT = "0x2222222222222222222222222222222222222222" as Hex;
export const ROUTER = "0x1111111111111111111111111111111111111111" as Hex;
export const USDT = "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7" as Hex;
export const PAYER_KEY = ("0x" + "a1".repeat(32)) as Hex;
export const payer = privateKeyToAccount(PAYER_KEY);

export class FakeChain implements ChainPort {
  relayerAddress = "0x4444444444444444444444444444444444444444" as Hex;
  merchant: MerchantRegistry = { payout: PAYOUT, refundSigner: PAYOUT, maxRelayFee: 100_000n };
  paused = false;
  settledOnChain = false;
  simulateFails = false;
  gasPrice = 1_000_000_000n; // 1 gwei
  gas = 150_000n;
  receiptStatus: "success" | "reverted" = "success";
  holdReceipt = false;
  sent: PayArgs[] = [];
  simulations = 0;
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
  async simulatePay() {
    this.simulations += 1;
    if (this.simulateFails) throw new Error("execution reverted: invalid signature");
    return this.gas;
  }
  async getGasPrice() {
    return this.gasPrice;
  }
  async sendPay(args: PayArgs) {
    this.sent.push(args);
    return ("0x" + this.sent.length.toString(16).padStart(64, "0")) as Hex;
  }
  waitForReceipt(): Promise<TxReceipt> {
    const r: TxReceipt = { status: this.receiptStatus, gasUsed: this.gas, effectiveGasPrice: this.gasPrice, blockNumber: 1n };
    if (!this.holdReceipt) return Promise.resolve(r);
    return new Promise((res) => (this.resolveReceipt = () => res(r)));
  }
  release() {
    this.resolveReceipt?.({} as TxReceipt);
  }
  async getBlockNumber() {
    return 100n;
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
    payerCap: 100_000_000n, // 100 USDT
    relayFee: 50_000n,
    rateLimitPerMinute: 1000,
    tokenDomain: { name: "Tether USD", version: "1" },
    explorerBaseUrl: "https://explorer.test",
    port: 0,
    ...over,
  };
}

export function makeEnv(cfgOver: Partial<Config> = {}) {
  const clock = { t: 1_800_000_000 };
  const chain = new FakeChain();
  const db = new Db(":memory:");
  const cfg = makeCfg(cfgOver);
  const svc = new RelayerService({ cfg, db, chain, now: () => clock.t });
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
