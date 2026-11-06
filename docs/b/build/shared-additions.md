# Additive packages/shared additions

## w5
packages/shared/src/schemas.ts (appended, no existing export changed):
- `ORDER_TOKEN_HEADER = "Quietpay-Order-Token"`
- `CustomerRefundItem` (.strict()): amount, status (pending|settled|failed), txHash?, createdAt
- `CustomerRefundStatus` (.strict()): orderId, status (pending|settled|partially_refunded|refunded), amountPaid, totalRefunded, remaining, currency "USDT", lastUpdatedAt (unix seconds), refunds[]
Amounts are token base-unit strings (6 decimals). Tests: packages/shared/test/build-customer-refund-status.test.ts.
