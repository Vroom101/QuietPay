# Review resolution

An independent source-level review (it read code, it did not run tests) reported fee-integrity, input-validation and
qualification problems. The review text itself was not supplied to this run, only the issues described in the task
prompt, so findings **A to I** below are lettered by this run from those descriptions. Each was treated as a hypothesis
and checked in the code before being fixed.

| # | Severity | Finding | Confirmed in code? | Status |
| --- | --- | --- | --- | --- |
| A | High | The payer's nonce bound merchant, order, payout and value but **not the relay fee**, so a compromised or misconfigured allowlisted relayer could submit any fee up to `maxRelayFee`. | Yes: `computeNonce` had no fee input. | **Fixed (Phase 1).** Nonce is now `keccak256(abi.encode(PAY_TAG v2, merchantId, orderId, payout, value, fee))`; the router recomputes it from the submitted fee, so a different fee gives a different nonce and the token rejects the signature. Test: `test_relayerCannotSubmitADifferentFeeThanThePayerSigned`. Shared vectors asserted in Solidity and TypeScript. |
| B | Medium | A fee equal to the whole payment was allowed (`fee > value` only). | Yes: guard was `fee > value`. | **Fixed (Phase 1).** Guard is `fee > maxRelayFee \|\| fee >= value`. Tests: `test_feeEqualToValueReverts`, `test_feeOfValueMinusOneSucceedsWhenTheCapAllows`. A maximum fee-share registry field was **not** added (not a small clean change); `maxRelayFee` stays the cap. |
| C | Medium | No way to rotate a merchant's `refundSigner`. | Yes: no setter. | **Fixed (Phase 1).** `setRefundSigner` (owner only, zero address rejected) emits `RefundSignerChanged`. Policy: the registry is operator-controlled in this MVP. Tests cover rotation, old signer stops working, receipts unchanged, non-owner rejected. |
| D | Medium | The router trusted that a pull moved exactly the authorized amount (no fee-on-transfer protection). | Yes: no balance check. | **Fixed (Phase 1).** `_pull` (pay and refund) requires the router's balance to rise by exactly the amount, else `TokenAmountMismatch`. Tests with a fee-on-transfer mock for pay and refund. |
| E | Medium | Missing rollback and encoding tests. | Yes. | **Fixed (Phase 1).** Failing payout, fee and refund transfers roll back with the authorization still unused; empty, 1, 64, 66-byte and fuzzed 65-byte signatures revert without panics; payout-change, multi-partial-refund tests added. |
| F | High (qualification) | The deployment and "first payment" used a self-minted stand-in token, not the official bounty USDT. | Yes. | **Fixed (Phase 1) in code, evidence in Phase 3.** The stand-in token, its test and every deploy path are removed; the old deployment is kept only as history with `"qualifying": false`. The fork test is renamed and labelled a simulated compatibility check. A qualifying deployment and live official-USDT payment are tracked in `live-usdt.md`. |
| G | High | `parseUsdt` pads and slices extra decimals, silently rounding amounts. | _Phase 2_ | _Pending_ |
| H | Medium | `formatUsdt` can hide small amounts. | _Phase 2_ | _Pending_ |
| I | Medium | No guard against the wrong chain or token. | _Phase 2 and 3_ | _Pending_ |
