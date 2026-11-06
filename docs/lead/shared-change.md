# Shared-change protocol

`contracts/` and `packages/shared` are owned by Lead. If you need a change there:

1. Open an issue or note in `docs/<owner>/decisions.md` stating the exact change.
2. Lead makes the change on `main` and tags if the spec shape changes.
3. Merge `main` into your branch. Never edit the shared folder on your branch.

Never hand-edit `pnpm-lock.yaml` conflicts; regenerate with `pnpm install`.
Never copy the ABI by hand; it is generated from the Foundry build into `packages/shared/src/abi`.

## Log

### Refunds (shared-change #1)
Merge `main` into your branch to pick this up. All additive except the two new error codes, which widen
`ErrorCode` (any exhaustive `Record<ErrorCode, ...>` in your code must gain two keys).

- `@quietpay/shared`: `REFUND_TAG`, `computeRefundNonce`, `buildRefundAuthorization`, `recoverRefundSigner`.
- New schemas: `RefundQuoteResponse`, `RefundRequest`, `RefundResponse`. `Order.refundedAmount` is optional.
- New error codes: `insufficient_refund_balance` (422), `payment_replayed` (409), with plain-word user messages.
- Fixtures: `refundQuote`, `refundResponse`, `orderPartiallyRefunded`.
- Mock relayer: `GET /v1/orders/:id/refund-quote?amount=` and `POST /v1/refund`.
- ABI regenerated from the build: `refund`, `computeRefundNonce`, `REFUND_TAG`, `Refunded`, and the longer `Receipt`
  (`refundCount`, `totalRefunded`).
- **B must build:** `GET /v1/orders/:id/refund-quote` and `POST /v1/refund` (merchant API key) on the relayer, and
  map token reverts to `insufficient_refund_balance`.
- **A:** the dashboard may show `refundedAmount`; there is still no refund control in P0 UI.
