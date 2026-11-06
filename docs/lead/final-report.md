# Final report (Lead, unattended run)

## Phases

| Phase | Status |
| --- | --- |
| 1. Router hardening, stand-in token removed | **Done** |
| 2. Shared package hardening (`shared-v2` tagged) | **Done** |
| 3. Qualifying deploy and live official-USDT payment | **Partly done**: router deployed and verified; payment and refund **pending: unfunded** |
| 4. Indexer and ledger | **Done**; the live sample is pending the payment (a labelled synthetic sample stands in) |
| 5. Late catch-up | Not run: waiting on official USDT (a poller checks every 10 minutes for 2 hours) |

## Tests

Contracts: **72 Foundry tests pass** (router 29, refund 24, hardening 13, deploy scripts 6) plus 1 fork compatibility test that skips offline.
Shared: **109 pass** (including every pay and refund vector in `fixtures/nonce-vectors.json`, 83 parser cases, the qualifying guard).
Indexer: **26 pass** (including an anvil end-to-end run with the real router).
Not green: B's relayer and A's dashboard tests, by design until they merge (see below).

## Router

`0xb9D475cdd817900B45C356169c6FdC379B942d82`, deploy block **12351795**, source verified, points at the official USDT
`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` on chain 1874. [Explorer](https://explorer.testnet.whitechain.io/address/0xb9D475cdd817900B45C356169c6FdC379B942d82).

## Live payment and refund

**pending: unfunded.** The payer wallet `0x30Ab1c2f5d1D8794FdFE60EFa412F80D03037478` (WBT 0) and the refund signer
`0xeF70298c52b917d2301F7331bfe7038550d2CD5d` hold no official USDT. The token has no public faucet and the run never mints or
substitutes a token. When funded: `packages/shared/scripts/live-payment.mjs` then `first-refund.mjs` (the payment script was proven end
to end on anvil, and refuses a payer with any WBT and any chain or token but the qualifying pair).

## Review findings (A to I; lettered by this run, the review text was not supplied)

A fee not bound (High): **fixed**. B fee equal to value (Medium): **fixed**. C refund signer rotation (Medium): **fixed**.
D balance-delta check (Medium): **fixed**. E rollback and encoding tests: **fixed**. F stand-in token / qualification (High):
**fixed in code, live evidence pending funds**. G lossy `parseUsdt` (High): **fixed**. H hidden decimals in `formatUsdt`
(Medium): **fixed**. I wrong chain or token guard (Medium): **fixed**. Details in `review-resolution.md`. A read-only Opus review of
the router changes found nothing exploitable; its deferred points (price not bound on-chain, fee recipient, Ownable2Step, rescue) are in
`decisions.md`.

## Nonce v2 and what A and B must do

The pay nonce is now `keccak256(PAY_TAG v2, merchantId, orderId, payout, value, fee)`. **B:** add `fee` to the `computePayNonce` call in
`packages/relayer/src/service.ts`, submit exactly `order.fee`, map `invalid_amount` and `budget_exceeded`, point at the new router,
call `assertQualifyingConfig`. **A:** make the store's `parseUsdt` call strict-safe, update the dashboard format and its test, show the
exact fee. Exact list with line numbers: `docs/lead/shared-change.md`. Until they merge, `main` is red in `packages/relayer` (does not
compile) and `apps/merchant-dashboard` (one test).

## Stand-in token references left in A and B folders

Only `packages/relayer/test/e2e-anvil.test.ts` (and a comment in `packages/relayer/src/config.ts`). None in contracts, scripts, shared,
the root README or `.env.example`.

## Blocked or pending (`blocked.md`)

Official USDT for the payer and refund signer (payment, refund, live ledger sample); A and B merging `main`; nothing else.

## Not done and not claimed

Hosted relayer, browser checkout run, relayer refund API and dashboard refund button, and the verifier. No audit, production custody or
INR conversion is claimed anywhere.

## Next step

The verifier core (reusing the exported row functions from `@quietpay/indexer`), once the live payment and refund exist.
