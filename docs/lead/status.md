# Status

## CP0 (shared specs): done, tag `shared-v1`
- Token facts read from the live USDT; primary path is `receiveWithAuthorization`. Live gasless tx recorded on 2026-11-06 (see the update below).

## CP1 (router and first payment): done on 2026-11-06
- Router deployed and verified; real payment from a zero-WBT payer recorded (see the update below).

## CP2 (full checkout): code complete locally, tag `cp2-local`
- Widget, relayer, SDK, store and dashboard merged; TS tests include an anvil end-to-end run with a zero-balance payer.
- Live chain run via a local relayer; hosted relayer and browser walkthrough still open.

## Update 2026-11-06: live on testnet
- An early router and a self-minted stand-in token were deployed on chain 1874 (superseded, not qualifying).
- Real gasless payment from a zero-WBT payer and a real partial refund recorded (see `first-payment.md`, `refund.md`).
- Still open: hosted relayer, relayer refund endpoints, browser run of the widget, P1.
- Indexer, ledger and CSV export built (`packages/indexer`, `docs/lead/ledger.md`); live sample in `docs/lead/samples/`.
06:46 Phase 1 | Tasks 1-6 | contracts hardened, 65 forge tests pass, stand-in token removed (awaiting Opus review)
06:48 Phase 1 | Opus review | no exploitable issue; v-normalize + underflow fix applied; 66 forge tests pass
06:53 Phase 2 | Tasks 1-6 | shared hardened, 108 shared tests pass; relayer + dashboard knowingly red until A/B merge
06:58 Phase 3 | Tasks 1,2,5,6 | qualifying router 0xb9D4...2d82 deployed+verified (block 12351795); payment/refund pending: unfunded
07:00 Phase 4 | indexer verified vs prompt | 26 tests, CLI live-checked on qualifying router; live sample pending funds
07:02 Final | report written | phases 1,2,4 done; phase 3 live payment/refund pending: unfunded; poller running
- 08:30 fix(relayer): fee in pay nonce, stand-in case removed (CI typecheck)
- 08:35 test(dashboard): exact six-decimal expectations (CI)
- 09:36 live payment + refund done on qualifying router; demo-store 400 fix
- 09:38 live indexer export (1 router row) saved; tag qualifying-v1
- 11:10 verifier built; live sample verified OK against chain 1874; pen test rounds 1-3 fixed
- 12:40 L0 reconcile written; baseline green (see reconcile.md)
- 13:15 L4 range pinning + rpc2 + checkpoint; L1 invariants added
- 13:50 L4 verifier independent of indexer + differential test
- 14:30 R1 on indexer/verifier: net unclamped, sidecar pins config, unanchored label, docs
- 15:00 L5/L7: scripts (fund-payer, tampered samples, qualify-check), feedback, README
- 15:40 L2 property tests, removed-log tests, live sample re-verified
- 18:40 final report written; mutation sweep killed (low memory), recorded in blocked.md

## Backend branch reconciliation with main

Main's contract, ABI, v2 pay nonces, hardened recovery, widget verification,
independent verifier, live deployment records and security suites take precedence.
The branch adds merchant refund endpoints and dashboard controls, persisted
merchant receipts, x402 facilitator/agent and paid API, plus a namespaced ledger
HTTP API. See ../b/frontend-integration.md for the merged API contract.
Older branch recovery tests were replaced with extension integration tests against
main's owner/hash-scoped state machine; main's security suites were retained.
Fresh Solidity/Anvil validation remains for CI on this Windows environment.

Main round 8 is also retained: qualifying-only relayer startup, RPC node chain
check, failed-auth throttling, 24-character merchant keys, bounded webhook
verification tolerance, recursive secret exclusions in Docker builds.

Merge validation: 1,117 local tests passed across the workspace (final shared
security-suite rerun included); 12 Anvil/live-RPC tests skipped. All workspace
TypeScript checks and widget/dashboard/store builds passed. Foundry/Anvil
execution remains for CI; no new live transactions were submitted.

Round 9 from main retained: known-good authenticated callers remain usable
under failed-auth throttling, and webhook delivery has bounded concurrency
with per-merchant/per-host fairness. Refund routes use the same auth guards.

After round 9: 1,149 tests passed across the current workspace suites (the
affected shared/SDK/relayer/facilitator suites were rerun); 12 optional tests
remain skipped locally.
- 20:40 finish run T0: baseline last green (relayer 324, shared 240, verifier 139, Foundry 118); gh unavailable so CI not read
- 21:20 T1 a-d done; mutation sweep running
- 21:50 mutation sweep done 58/60 killed, 2 killed by new tests; trailers removed from pushed history (backup branches local)
