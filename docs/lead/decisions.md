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

## Pen test round 1 (contracts): accepted finding
`registerMerchant` and `setPayout` accept the router (or token) address as a merchant payout, which would strand funds (low, owner-only misconfiguration; no sweep function). Fixing it changes the bytecode, which means redeploying the qualifying router and repeating the live evidence, so it is accepted for now and queued for the next router version (reject `address(this)` and `address(token)` in both functions; add a rescue). Pinned by `test_DOC_payoutCanBeRouterItselfStrandingFunds_knownAccepted`. Other adversarial attacks (32 tests in `PenTestRouter.t.sol`: replay, malleability, reentrancy, refund races, privilege escalation, fee and window edges) held.

## Net amount meaning (L3, Opus R1)
Merchant view, unclamped: `net = value - fee - refunded`, negative after a refund beyond `value - fee`. The payout receives `value - fee` and refunds are funded by the merchant's refund signer, so clamping would hide a real loss and overstate income when rows are summed. Only `net_usdt` may carry a sign; `-0.000000` is invalid. Dashboard (A): if it shows net, it must render a leading minus.

## Router review R1/R3 (Opus, read-only): three Low findings, accepted, no redeploy
Contract change gate: no Critical or High, so the qualifying router stays. Each is pinned by `contracts/test/ExpectedLimitations.t.sol`.
1. **Outgoing transfers are not balance-checked** (only the pull is). A token whose admin enables a transfer-only fee would underpay the merchant or payer while events claim full amounts. Mitigation: monitor the token implementation and fee rate off-chain. Fix in a later router: check balance deltas on both payout legs and the refund leg.
2. **Plain `Ownable`**: `pause()` then `renounceOwnership()` (or a mistyped transfer) locks `pay` and `refund` for good. The router holds no funds. Later router: `Ownable2Step`, disable renounce.
3. **Zero `orderId`/`merchantId` accepted.** Mitigation now: relayer must reject zero ids (listed for B in `shared-change.md`). Later router: revert on zero ids.
Checked with no new finding: reentrancy, paused or blacklisting token, signer rotation, payout change, same order under two merchants, fee at value-1, nonce collisions across pay and refund, high-s signatures.

## T1d: narrowest double-count rule (Opus design gate)
Every Transfer the router makes either goes to the router (pull) or comes from it (payout, relay fee, refund), so no router-made Transfer has `to == payTo` and `from != router` unless payTo is the router itself. The old second condition ("no router Paid/Refunded in the same tx") hid genuine direct deposits batched with a pay or refund by a contract relayer. New rule: a Transfer is a `payto_transfer` deposit iff `to == payTo` and `from != router`; a payTo equal to the router is refused. Mirrored independently in `indexer/src/ledger.ts` and `verifier/src/spec.ts`, tests in `verifier/test/double-count.test.ts`. Not done: require the verifier's invariant check to match every leftover same-tx payTo transfer to a CSV row (row comparison already covers it).

## Router R2 (economics, gas; Opus, read only): no Critical/High, no redeploy
- **Medium (accepted, off-chain bound):** `pay` writes the receipt before `_pull`, so a payer who moves their USDT away or cancels the authorization after the relayer simulated makes the relayer's tx revert at a gas cost over twice the payer's action (pinned by `test_LIMITATION_payerCanMakeRelayerBurnMoreGasThanTheyPay`). Mitigations already in the relayer: simulation before send, per-payer revert limits, first-time-payer loss caps, hourly loss budget, and a minimum remaining signed window. A later router should pull before writing the receipt.
- **Low:** refunds have no fee or minimum, so dust refunds are paid for by the operator (bounded by the relayer's per-merchant rate limit and loss budget). **Low:** `maxRelayFee` has no setter (new merchant id is the workaround). **Info:** refund nonces bind `refundCount`, so a cancelled refund #0 forces re-signing #1.
- Checked, nothing new: order-id squatting, third-party nonce burning, two payers on one order, fee edges, refundCount wrap, window boundaries, pause with outstanding signatures, payout change before refund, relayer-vs-relayer front-run, storage growth.
