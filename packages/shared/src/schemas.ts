import { z } from "zod";

const hex = (len?: number) =>
  z
    .string()
    .regex(len ? new RegExp(`^0x[0-9a-fA-F]{${len}}$`) : /^0x[0-9a-fA-F]*$/, "invalid hex");

export const Address = hex(40);
export const Bytes32 = hex(64);
export const Signature = hex(130); // 65-byte r||s||v
export const TxHash = hex(64);
/** Token base units (USDT has 6 decimals), as a decimal string. */
const UINT256_MAX = (1n << 256n) - 1n;
export const Amount = z
  .string()
  .regex(/^[1-9][0-9]*$/, "must be a positive integer string")
  // At most 78 digits (uint256 max has 78) and no larger than 2^256 - 1. The regex guard keeps BigInt from seeing non-digits.
  .refine((s) => /^[1-9][0-9]{0,77}$/.test(s) && BigInt(s) <= UINT256_MAX, "must fit in uint256");

export const OrderStatus = z.enum(["created", "pending", "settled", "failed", "expired", "partially_refunded", "refunded"]);
export type OrderStatus = z.infer<typeof OrderStatus>;

/** What the payer signs. `from`, `validAfter` and `validBefore` are filled in by the widget. */
export const CheckoutParams = z.object({
  chainId: z.number().int(),
  token: Address,
  router: Address,
  value: Amount,
  nonce: Bytes32,
  payout: Address,
  fee: Amount.or(z.literal("0")),
  domain: z.object({ name: z.string(), version: z.string() }),
});
export type CheckoutParams = z.infer<typeof CheckoutParams>;

export const Order = z.object({
  id: Bytes32, // orderId
  merchantId: Bytes32,
  amount: Amount,
  status: OrderStatus,
  reference: z.string().max(200).optional(),
  payout: Address,
  fee: Amount.or(z.literal("0")),
  payer: Address.optional(),
  txHash: TxHash.optional(),
  failureCode: z.string().optional(),
  createdAt: z.number().int(), // unix seconds
  expiresAt: z.number().int(),
  settledAt: z.number().int().optional(),
  /** Total refunded so far, in base units. Absent means zero. */
  refundedAmount: Amount.or(z.literal("0")).optional(),
  refunded: Amount.or(z.literal("0")).optional(),
  refundCount: z.number().int().nonnegative().optional(),
  /** Gas the relayer spent on this order (pay, cancel, refund, reverted attempts), wei. Merchant list only. */
  gasWei: Amount.or(z.literal("0")).optional(),
  // http(s) only: a javascript:/data: URL here would become a clickable link in the widget and dashboard.
  explorerUrl: z.string().url().refine((u) => /^https?:\/\//i.test(u), "explorerUrl must be http(s)").optional(),
  checkout: CheckoutParams,
}).refine((o) => o.fee === o.checkout.fee && o.amount === o.checkout.value && o.payout.toLowerCase() === o.checkout.payout.toLowerCase(), {
  message: "order amount, fee and payout must equal what the payer signs (checkout.value, checkout.fee, checkout.payout)",
});
export type Order = z.infer<typeof Order>;

// ---- POST /v1/orders (merchant API key) ----
export const CreateOrderRequest = z.object({
  merchantId: Bytes32,
  amount: Amount,
  reference: z.string().max(200).optional(),
  /**
   * http(s) only, no credentials. The relayer additionally refuses loopback, private, link-local and
   * metadata targets (unless its operator sets ALLOW_PRIVATE_WEBHOOKS for local development).
   */
  webhookUrl: z
    .string()
    .max(2048)
    .url()
    .refine((s) => {
      try {
        const u = new URL(s);
        return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
      } catch {
        return false;
      }
    }, "webhookUrl must be an http(s) URL without credentials")
    .optional(),
  expiresInSeconds: z.number().int().min(60).max(86_400).optional(),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;
export const CreateOrderResponse = Order;
export type CreateOrderResponse = Order;

// ---- POST /v1/relay/pay ----
export const RelayPayRequest = z.object({
  orderId: Bytes32,
  payer: Address,
  validAfter: z.number().int().nonnegative(),
  validBefore: z.number().int().positive(),
  signature: Signature,
  /** Optional echo of the price the payer saw. The relayer rejects with amount_mismatch if it differs from the order. */
  amount: Amount.optional(),
});
export type RelayPayRequest = z.infer<typeof RelayPayRequest>;
export const RelayPayResponse = z.object({
  orderId: Bytes32,
  status: OrderStatus,
  txHash: TxHash.optional(),
});
export type RelayPayResponse = z.infer<typeof RelayPayResponse>;

// ---- GET /v1/orders/:id (public) ----
export const GetOrderResponse = Order;
export type GetOrderResponse = Order;

// ---- GET /v1/orders (merchant API key; dashboard) ----
export const ListOrdersResponse = z.object({ orders: z.array(Order) });
export type ListOrdersResponse = z.infer<typeof ListOrdersResponse>;

// ---- GET /v1/health ----
export const HealthResponse = z.object({
  ok: z.boolean(),
  chainId: z.number().int(),
  router: Address,
  token: Address,
  relayer: Address,
  paused: z.boolean(),
  blockNumber: z.number().int().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

// ---- GET /v1/metrics (operator token) ----
export const MetricsResponse = z.object({
  agentPayments: z.object({ settling: z.number().int(), settled: z.number().int(), failed: z.number().int() }).optional(),
  balanceWbt: z.string().nullable().optional(),
  lowBalance: z.boolean().optional(),
  lowBalanceThresholdWbt: z.string().optional(),
  orders: z.record(OrderStatus, z.number().int()),
  relayed: z.number().int(),
  rejected: z.record(z.string(), z.number().int()),
  lossBudget: z.object({
    limitWbtPerHour: z.string(),
    spentWbtLastHour: z.string(),
  }),
  paused: z.boolean(),
});
export type MetricsResponse = z.infer<typeof MetricsResponse>;

// ---- POST /v1/admin/pause (operator token) ----
export const AdminPauseRequest = z.object({ paused: z.boolean() });
export type AdminPauseRequest = z.infer<typeof AdminPauseRequest>;
export const AdminPauseResponse = z.object({ paused: z.boolean() });
export type AdminPauseResponse = z.infer<typeof AdminPauseResponse>;

// ---- Refunds (merchant API key) ----
// GET /v1/orders/:id/refund-quote?amount=...  -> what the refundSigner must sign
export const RefundQuoteResponse = z.object({
  orderId: Bytes32,
  merchantId: Bytes32,
  payer: Address,
  amount: Amount,
  refundIndex: z.number().int().nonnegative(),
  nonce: Bytes32,
  totalRefunded: Amount.or(z.literal("0")),
  remaining: Amount.or(z.literal("0")),
  refundSigner: Address,
  chainId: z.number().int(),
  token: Address,
  router: Address,
  domain: z.object({ name: z.string(), version: z.string() }),
});
export type RefundQuoteResponse = z.infer<typeof RefundQuoteResponse>;

// POST /v1/refund
export const RefundRequest = z.object({
  orderId: Bytes32,
  amount: Amount,
  validAfter: z.number().int().nonnegative(),
  validBefore: z.number().int().positive(),
  signature: Signature,
});
export type RefundRequest = z.infer<typeof RefundRequest>;
export const RefundResponse = z.object({
  orderId: Bytes32,
  amount: Amount,
  refundIndex: z.number().int().nonnegative(),
  totalRefunded: Amount,
  txHash: TxHash,
});
export type RefundResponse = z.infer<typeof RefundResponse>;

export const RefundContext = z.object({
  orderId: Bytes32, merchantId: Bytes32, payer: Address, refundSigner: Address,
  amountPaid: Amount, refunded: Amount.or(z.literal("0")), refundIndex: z.number().int().nonnegative(),
  refundBalance: Amount.or(z.literal("0")), chainId: z.number().int(), token: Address, router: Address,
  domain: z.object({ name: z.string(), version: z.string() }),
});
export type RefundContext = z.infer<typeof RefundContext>;
export const RelayRefundRequest = z.object({
  orderId: Bytes32, amount: Amount, refundIndex: z.number().int().nonnegative(),
  validAfter: z.number().int().nonnegative(), validBefore: z.number().int().positive(), signature: Signature,
});
export type RelayRefundRequest = z.infer<typeof RelayRefundRequest>;
export const Refund = z.object({
  id: Bytes32, orderId: Bytes32, amount: Amount, refundIndex: z.number().int().nonnegative(),
  status: z.enum(["pending", "settled", "failed"]), txHash: TxHash.optional(),
  failureCode: z.string().optional(), createdAt: z.number().int(),
});
export type Refund = z.infer<typeof Refund>;

export const ListRefundsResponse = z.object({ refunds: z.array(Refund) });

// ---- Customer-facing refund status (additive; served by a store, never by the relayer) ----

/** Header that carries the order status token. It must never travel in a URL or query string. */
export const ORDER_TOKEN_HEADER = "Quietpay-Order-Token";

/** One refund as a customer may see it: no ids, no failure codes, no signer or payout details. */
export const CustomerRefundItem = z.object({
  amount: Amount,
  status: z.enum(["pending", "settled", "failed"]),
  txHash: TxHash.optional(),
  createdAt: z.number().int(),
}).strict();
export type CustomerRefundItem = z.infer<typeof CustomerRefundItem>;

/** What GET /api/orders/:id/refund-status returns. Amounts are token base units (6 decimals) as strings. */
export const CustomerRefundStatus = z.object({
  orderId: Bytes32,
  status: z.enum(["pending", "settled", "partially_refunded", "refunded"]),
  amountPaid: Amount,
  totalRefunded: Amount.or(z.literal("0")),
  remaining: Amount.or(z.literal("0")),
  currency: z.literal("USDT"),
  lastUpdatedAt: z.number().int(),
  refunds: z.array(CustomerRefundItem),
}).strict();
export type CustomerRefundStatus = z.infer<typeof CustomerRefundStatus>;
