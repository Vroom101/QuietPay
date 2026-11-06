# Lead decisions

## Refunds
- **Receipt layout.** `Receipt` gained `refundCount` (uint32) and `totalRefunded` (uint256). Safe because nothing is
  deployed yet; if a P0 router is deployed before this ships, the refund build needs a redeploy.
- **Spec vs code.** The refund spec says the contract reverts cleanly when the `refundSigner` is short of USDT and the API
  layer uses `insufficient_refund_balance`. The contract surfaces the token's revert; the mapping is the relayer's job.
- **`payment_replayed`.** Added to the shared error codes as requested. The router itself reports a replayed refund as the
  token's `invalid signature` revert (the nonce moves with the index); the relayer can translate it.
- **No `refundSigner` setter.** The registry has no way to change `refundSigner` after registration (as in P0). Rotating it
  means a new merchant id. Flagged rather than added, since the frozen interface does not list one.
- **Plan B.** Not applicable: the token gate chose the primary `receiveWithAuthorization` path.
- **Webhook.** No `payment.refunded` event was added; the frozen webhook types stay `payment.settled` and `payment.failed`.
- **Order schema.** Optional `refundedAmount` added (additive).

## Indexer and ledger
- **`net_usdt` is clamped at zero.** The spec says `value - fee - refunded`, but the router allows refunds up to the gross
  value, so a full refund would give `-fee`. The spec also says a full refund has net zero, so the ledger uses
  `max(0, ...)`. Documented in `ledger.md`.
- **Deploy block** is now recorded in `deployments.json` (`deployBlock`: 12347996) and mirrored to `packages/shared`.
- **Unfinalized window.** Nothing non-final is stored, so "re-reading the window" happens automatically: the next run
  starts at `cursor + 1` and reads those blocks once they are final. A cursor-hash mismatch (deep reorg) stops the run.
- **Incremental ledger update** recomputes rows from the full raw set and upserts only rows touched by the batch;
  `rebuild` upserts all. Both are tested to give identical rows.
- **Sample export.** The sample's x402 row is a deployer-to-payout transfer, not real facilitator traffic.
- **Optional env.** `FACILITATOR_PAYTO` (empty disables x402 rows), `DEPLOY_BLOCK`, `POLL_SECONDS`, `GENERATED_AT`.
