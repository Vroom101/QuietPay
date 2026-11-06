import { z } from "zod";
import { Amount, Bytes32, Refund, RefundContext } from "./schemas.js";

export const MerchantRefundRequest = z
  .object({
    requestId: z.string().uuid(),
    amount: Amount.max(78),
    refundIndex: z.number().int().nonnegative(),
  })
  .strict();
export const MerchantRefundOperation = z.object({
  requestId: z.string().uuid(),
  orderId: Bytes32,
  amount: Amount,
  refundIndex: z.number().int().nonnegative(),
  status: z.enum(["submitting", "unknown", "pending", "settled", "failed"]),
  refund: Refund.optional(),
  failureCode: z.string().optional(),
  createdAt: z.number().int(),
});
export type MerchantRefundOperation = z.infer<typeof MerchantRefundOperation>;
export const MerchantRefundView = z.object({
  context: RefundContext,
  refunds: z.array(Refund),
  requests: z.array(MerchantRefundOperation),
});
export type MerchantRefundView = z.infer<typeof MerchantRefundView>;
