# Backend decisions

- **Guard order.** Rate limit first (cheapest), then order lookup, amount echo, signature recovery,
  merchant/fee/payout checks, pause, per-payer cap, on-chain receipt, then simulation, gas price and
  loss budget under a lock. Nothing broadcasts unless all pass.
- **Payout drift.** If the registry payout differs from the payout stored on the order, the nonce the
  payer signed no longer matches the router's recomputation. The relayer marks the order expired and
  returns `order_expired` so the store creates a fresh one.
- **Idempotency.** The same signature on the same order returns the same hash. A different signature
  for a pending or settled order returns `already_settled`. A `failed` order may be retried with a new signature.
- **Per-payer cap.** `PAYER_CAP_USDT` is cumulative over a rolling 24 hours (pending + settled + partially/full refunded; refunds do not reset the cap) and
  returns `rate_limited`.
- **Gas ceiling / loss budget** return `relayer_paused` with a plain message, since no frozen code fits better.
- **Loss budget accounting.** An estimate (gas limit x gas price) is recorded at broadcast and replaced with
  actual gas used when the receipt lands. The check runs under a lock so concurrent requests cannot overshoot.
- **Optional env vars added** (defaults exist): `RELAY_FEE_USDT`, `RATE_LIMIT_PER_MINUTE`,
  `EXPLORER_BASE_URL`, `PORT`. The frozen list is unchanged.
- **Shared change.** `RelayPayRequest.amount` (optional) was added so `amount_mismatch` has a real trigger.
- **Unknown merchant** at order creation returns `simulation_failed` ("not registered"); no frozen code fits.
- **Rate limiter** is in memory. It resets on restart; the loss budget is persisted in SQLite and does not.

- **Refund context and signing.** The merchant-authenticated context reads the router receipt one block behind the head (two confirmations), registry refundSigner and token balance. The SDK pins merchant, order, router, network and token, signs in the merchant server and requires an expected refund index.
- **Refund idempotency.** IDs hash the complete signed request. One pending refund per order is allowed. Failed transactions can be retried with a new signature at the same on-chain index; exact retries return the stored refund, including its failure.
- **Refund recovery.** Separate refund rows share the payment sender lock, wallet nonce manager, attempt log and gas budget. Settlement updates refund totals, order status, actual gas and webhook enqueue atomically. The original payment hash remains on the order.
- **Contract compatibility.** Refunds add receipt fields and a new router method. The ABI is generated from Foundry. Preflight requires the expected REFUND_TAG; older immutable routers require a new deployment.

On Windows, the tools installed during this implementation are in
`$env:LOCALAPPDATA\QuietPay-tools\foundry-v1.9.0`. Add that folder to the current
shell's PATH, or set `ANVIL_BIN` to its `anvil.exe`, before running the integration.
Local runs skip integration if artifacts or Anvil are unavailable; CI requires both.
Use Node 20 for the locked SQLite dependency.
