# Refunds

Gasless partial refunds in `PaymentRouter`. Status: **contract, tests, shared builders and mock endpoints done. Deployed, verified and used on the testnet.**
The relayer HTTP endpoints for refunds are not built yet; the live refund below was submitted by the relayer wallet
directly through `packages/shared/scripts/first-refund.mjs`.

## Flow

1. The merchant asks for a quote: `GET /v1/orders/:id/refund-quote?amount=<base units>` returns the payer
   (read from the receipt), the next `refundIndex`, the nonce, the remaining refundable amount and the signing domain.
2. The merchant's `refundSigner` wallet signs the token's `ReceiveWithAuthorization` with `to` = router and
   `value` = refund amount (`buildRefundAuthorization` in `@quietpay/shared`).
3. `POST /v1/refund` (relayer endpoint, built by B) calls `PaymentRouter.refund(...)`. The router recomputes the nonce,
   pulls `amount` from the `refundSigner` through the token, and forwards exactly `amount` to the stored payer.

## Contract rules (as built)

- `refund(merchantId, orderId, amount, validAfter, validBefore, signature)`, allowlisted relayers only, not when paused.
- Nonce is `keccak256(abi.encode(REFUND_TAG, merchantId, orderId, payer, amount, refundIndex))`, computed on-chain;
  `payer` is the receipt's payer and cannot be passed in. `refundIndex` is the receipt's refund count, so each refund has
  its own nonce and a signature cannot be replayed or reordered.
- `amount > 0` and `totalRefunded + amount <= value`, where `value` is the gross amount paid (not net of the relay fee).
- Same validity window rules as `pay` (`validBefore - validAfter <= 10 minutes`).
- `totalRefunded` and `refundCount` are written before any token call. If the `refundSigner` holds too little USDT the
  token call reverts and the whole transaction reverts, leaving the receipt unchanged. The authorization is not consumed.
- A fully refunded order stays settled; a second `pay` for the same key still reverts.
- Emits `Refunded(merchantId, orderId, payer, amount, totalRefunded, refundIndex)`.
- **Relay fee on refunds is zero in the MVP. The operator absorbs gas.**

## Errors (API layer)

`insufficient_refund_balance` (422) is for the relayer to return when the refundSigner balance is too low (check before
broadcast, and map a token revert to it). `payment_replayed` (409) is for an already-used authorization.

## Tests

`contracts/test/PaymentRouterRefund.t.sol`: 24 tests, covering the 15 requested cases (happy path, sequential partials,
exact full refund, over-refund, zero, non-relayer, unknown order, replay, payer/amount/order binding, wrong signer,
low balance, windows, pause, second pay after full refund, reentrancy) plus a fuzz on the cap, per-merchant signers and a
Solidity/TypeScript nonce parity pin. The reentrancy test uses a token that calls back into a contract payer that is
itself an allowlisted relayer, so only the reentrancy guard can stop the nested call.

## Real testnet refund

Partial refund of 2.00 of the 5.00 demo USDT paid in `first-payment.md`, signed by the demo merchant's refundSigner and
submitted by the relayer wallet: https://explorer.testnet.whitechain.io/tx/0xf628b683710360ccc20c1de1287e522d429112a1f431547bc798ea62384c0038

Afterwards the payer's balance rose by exactly 2.00 USDT and the refundSigner's fell by 2.00; the order's
`refundCount` is 1 and `totalRefunded` is 2.00. The router is the verified contract at https://explorer.testnet.whitechain.io/address/0x6a765694262E1c9CdDbb1C76008a61df7f58D86f.
