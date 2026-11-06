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
export const Amount = z.string().regex(/^[1-9][0-9]*$/, "must be a positive integer string");

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
  refunded: Amount.or(z.literal("0")).optional(),
  refundCount: z.number().int().nonnegative().optional(),
  reference: z.string().max(200).optional(),
  payout: Address,
  fee: Amount.or(z.literal("0")),
  payer: Address.optional(),
  txHash: TxHash.optional(),
  failureCode: z.string().optional(),
  createdAt: z.number().int(), // unix seconds
  expiresAt: z.number().int(),
  settledAt: z.number().int().optional(),
  explorerUrl: z.string().url().optional(),
  checkout: CheckoutParams,
});
export type Order = z.infer<typeof Order>;

// ---- POST /v1/orders (merchant API key) ----
export const CreateOrderRequest = z.object({
  merchantId: Bytes32,
  amount: Amount,
  reference: z.string().max(200).optional(),
  webhookUrl: z.string().url().optional(),
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
