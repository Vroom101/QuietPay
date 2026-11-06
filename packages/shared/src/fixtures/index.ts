import type { Address, Hex } from "viem";
import { computePayNonce, computeRefundNonce, merchantIdFromSlug, token } from "../typed-data.js";
import type { Order, RefundQuoteResponse, RefundResponse, RelayPayResponse } from "../schemas.js";
import type { WebhookEvent } from "../webhook.js";

/** Deterministic fixtures. Addresses are well-known throwaway values, not real wallets. */
export const FIXTURE_ROUTER = "0x1111111111111111111111111111111111111111" as Address;
export const FIXTURE_PAYOUT = "0x2222222222222222222222222222222222222222" as Address;
export const FIXTURE_PAYER = "0x3333333333333333333333333333333333333333" as Address;
export const FIXTURE_RELAYER = "0x4444444444444444444444444444444444444444" as Address;
export const FIXTURE_MERCHANT_ID = merchantIdFromSlug("demo-store");
export const FIXTURE_ORDER_ID = ("0x" + "ab".repeat(32)) as Hex;
export const FIXTURE_TX_HASH = ("0x" + "cd".repeat(32)) as Hex;
export const FIXTURE_NOW = 1_800_000_000;

export function makeOrder(over: Partial<Order> & { id?: Hex; amount?: string; fee?: string } = {}): Order {
  const id = over.id ?? FIXTURE_ORDER_ID;
  const amount = over.amount ?? "25000000";
  const fee = over.fee ?? "50000";
  return {
    id,
    merchantId: FIXTURE_MERCHANT_ID,
    amount,
    status: "created",
    reference: "demo-cart-1",
    payout: FIXTURE_PAYOUT,
    fee,
    createdAt: FIXTURE_NOW,
    expiresAt: FIXTURE_NOW + 900,
    checkout: {
      chainId: token.chainId,
      token: token.address,
      router: FIXTURE_ROUTER,
      value: amount,
      nonce: computePayNonce({
        merchantId: FIXTURE_MERCHANT_ID,
        orderId: id,
        payout: FIXTURE_PAYOUT,
        value: BigInt(amount),
        fee: BigInt(fee),
      }),
      payout: FIXTURE_PAYOUT,
      fee,
      domain: token.eip712Domain,
    },
    ...over,
  };
}

export const orderCreated = makeOrder();
export const orderPending = makeOrder({ status: "pending", payer: FIXTURE_PAYER, txHash: FIXTURE_TX_HASH });
export const orderSettled = makeOrder({
  status: "settled",
  payer: FIXTURE_PAYER,
  txHash: FIXTURE_TX_HASH,
  settledAt: FIXTURE_NOW + 3,
  explorerUrl: `https://sepolia.whitechain.io/tx/${FIXTURE_TX_HASH}`,
});
export const orderFailed = makeOrder({ status: "failed", failureCode: "simulation_failed" });
export const orderExpired = makeOrder({ status: "expired" });

export const relayPayPending: RelayPayResponse = {
  orderId: FIXTURE_ORDER_ID,
  status: "pending",
  txHash: FIXTURE_TX_HASH,
};

export const webhookSettled: WebhookEvent = {
  id: "evt_fixture_settled_0001",
  type: "payment.settled",
  createdAt: FIXTURE_NOW + 3,
  data: {
    orderId: FIXTURE_ORDER_ID,
    merchantId: FIXTURE_MERCHANT_ID,
    amount: "25000000",
    fee: "50000",
    payer: FIXTURE_PAYER,
    payout: FIXTURE_PAYOUT,
    txHash: FIXTURE_TX_HASH,
    reference: "demo-cart-1",
  },
};

export const webhookFailed: WebhookEvent = {
  id: "evt_fixture_failed_0001",
  type: "payment.failed",
  createdAt: FIXTURE_NOW + 3,
  data: { ...webhookSettled.data, txHash: undefined, failureCode: "simulation_failed" },
};

export const FIXTURE_REFUND_SIGNER = "0x5555555555555555555555555555555555555555" as Address;
export const FIXTURE_REFUND_TX_HASH = ("0x" + "ef".repeat(32)) as Hex;

export const refundQuote: RefundQuoteResponse = {
  orderId: FIXTURE_ORDER_ID,
  merchantId: FIXTURE_MERCHANT_ID,
  payer: FIXTURE_PAYER,
  amount: "10000000",
  refundIndex: 0,
  nonce: computeRefundNonce({
    merchantId: FIXTURE_MERCHANT_ID,
    orderId: FIXTURE_ORDER_ID,
    payer: FIXTURE_PAYER,
    amount: 10_000_000n,
    refundIndex: 0,
  }),
  totalRefunded: "0",
  remaining: "25000000",
  refundSigner: FIXTURE_REFUND_SIGNER,
  chainId: token.chainId,
  token: token.address,
  router: FIXTURE_ROUTER,
  domain: token.eip712Domain,
};

export const refundResponse: RefundResponse = {
  orderId: FIXTURE_ORDER_ID,
  amount: "10000000",
  refundIndex: 0,
  totalRefunded: "10000000",
  txHash: FIXTURE_REFUND_TX_HASH,
};

export const orderPartiallyRefunded = makeOrder({
  status: "settled",
  payer: FIXTURE_PAYER,
  txHash: FIXTURE_TX_HASH,
  settledAt: FIXTURE_NOW + 3,
  refundedAmount: "10000000",
});
