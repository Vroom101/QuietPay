# Backend decisions

- **Guard order.** Rate limit first (cheapest), then order lookup, amount echo, signature recovery,
  merchant/fee/payout checks, pause, per-payer cap, on-chain receipt, then simulation, gas price and
  loss budget under a lock. Nothing broadcasts unless all pass.
- **Payout drift.** If the registry payout differs from the payout stored on the order, the nonce the
  payer signed no longer matches the router's recomputation. The relayer marks the order expired and
  returns `order_expired` so the store creates a fresh one.
- **Idempotency.** The same signature on the same order returns the same hash. A different signature
  for a pending or settled order returns `already_settled`. A `failed` order may be retried with a new signature.
- **Per-payer cap.** `PAYER_CAP_USDT` is cumulative over a rolling 24 hours (pending + settled) and
  returns `rate_limited`.
- **Gas ceiling / loss budget** return `relayer_paused` with a plain message, since no frozen code fits better.
- **Loss budget accounting.** An estimate (gas limit x gas price) is recorded at broadcast and replaced with
  actual gas used when the receipt lands. The check runs under a lock so concurrent requests cannot overshoot.
- **Optional env vars added** (defaults exist): `RELAY_FEE_USDT`, `RATE_LIMIT_PER_MINUTE`,
  `EXPLORER_BASE_URL`, `PORT`. The frozen list is unchanged.
- **Shared change.** `RelayPayRequest.amount` (optional) was added so `amount_mismatch` has a real trigger.
- **Unknown merchant** at order creation returns `simulation_failed` ("not registered"); no frozen code fits.
- **Rate limiter** is in memory. It resets on restart; the loss budget is persisted in SQLite and does not.
