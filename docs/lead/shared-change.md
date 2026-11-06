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

### Pay nonce v2 binds the relay fee (shared-change #2, contract change)

**Status: contract done in Phase 1; TypeScript lands in Phase 2 (tag `shared-v2`). Read this before merging `main`.**

The router now recomputes the payer's nonce as
`keccak256(abi.encode(PAY_TAG, merchantId, orderId, payout, value, fee))` with `PAY_TAG = keccak256("quietpay.pay.v2")`.
A relayer that submits a different fee than the payer signed makes the token reject the signature.

- **B (relayer):** submit **exactly** `order.fee` to `pay(...)`. Create orders with the nonce
  `computePayNonce({merchantId, orderId, payout, value, fee})`; the `fee` argument becomes required in `@quietpay/shared`.
  `packages/relayer/src/service.ts` (`createOrder`) calls `computePayNonce` without a fee and must be updated.
- **A (widget):** the order response already returns `fee` and `checkout.nonce`; the payer must sign the nonce from the
  order (already how the widget works). Show the fee the order quotes. No nonce arithmetic is needed in the widget.
- Vectors both languages must match: `packages/shared/fixtures/nonce-vectors.json`.
- Router ABI changed: `computeNonce(merchantId, orderId, payout, value, fee)`, new `setRefundSigner`, new errors
  `TokenAmountMismatch`; `fee >= value` now reverts `FeeOverCap`.

### Stand-in token removal (contracts, shared, root README, `.env.example`)

The self-minted stand-in token is gone from everything Lead owns. **Remaining references in A and B folders to remove:**
- `packages/relayer/test/e2e-anvil.test.ts`: the `DemoUSDT` artifact path and the "own EIP-712 domain" test case
  (those artifacts no longer exist, so the test is skipped by its artifact check until updated). The mock token artifact
  is now `contracts/out/MockAuthToken.sol/MockAuthToken.json` (function `mint`, domain `Tether USD` / `1`).
- `packages/relayer/src/config.ts`: the comment "Set for the demo token" on `TOKEN_DOMAIN_NAME`.
