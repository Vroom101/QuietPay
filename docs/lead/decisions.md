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

## Router hardening (Phase 1)
- **Fee commitment.** Fee is part of the pay nonce (`quietpay.pay.v2`). Refund nonces are unchanged. `maxRelayFee` stays as a
  second cap. No maximum fee-share registry field was added.
- **Refund signer rotation.** Owner-only (the registry is operator-controlled in this MVP). Rotating back to an old key
  re-enables that key's unused, unexpired authorizations (windows are at most 10 minutes); noted, not mitigated.
- **Balance delta.** Costs two extra `balanceOf` calls per pull (a few thousand gas). The router supports only the official
  test USDT, which this check protects; a lossy token makes the router fail closed.
- **Signature `v`.** `0/1` recovery ids are normalized to `27/28`.
- **Opus review (read-only), result.** No exploitable issue in the four changes. Accepted or deferred items:
  - *Price is not bound on-chain* (Medium): `value` is whatever the payer signs, so a payer who guesses an order id could
    settle it with a different value. Mitigation lives in the relayer, which only relays orders it issued and rejects
    amounts that differ from the order (`amount_mismatch`, signature recovered against the order's own value), plus
    random 32-byte order ids. A merchant-signed quote checked in `pay` would change the frozen interface; not done.
  - *Fee recipient is `msg.sender`*: another allowlisted relayer could front-run a signature and take the fee. Accepted
    as the cost of relayer failover; the payer and merchant are unaffected.
  - *`Ownable2Step`, refunds while paused, a rescue function for tokens sent directly to the router*: considered and not
    added (the spec says a paused router reverts refunds; direct transfers are documented as unrecoverable).
  - *The payer's wallet shows an opaque nonce*: documented limitation; consent depends on the widget showing the fee.

## Phase 4 follow-ups
- The earlier live sample export came from the superseded stand-in router, so it was removed (it stays in git history). A
  clearly labelled synthetic sample replaces it until a real official-USDT payment exists.
- The indexer's decimals now come from `token.json` (default) instead of a hardcoded 6; the CLI accepts only the qualifying
  router and the official USDT on chain 1874.
- forge writes the wrong hash into `transactions[].hash` of a broadcast file for the creation tx; `record-deployment.mjs`
  reads the creation receipt instead.
