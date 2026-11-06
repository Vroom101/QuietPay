# Final report (Lead run, 2026-11-06)

Deadline placeholder was not filled in, so contracts were treated as frozen (no redeploy). "No findings" below means not found by these methods, not proven safe.

## 1. Components
| Component | State |
|---|---|
| L0 Reconcile | done (`reconcile.md`) |
| L1 Router hardening | partly done: invariants added (3, ~128k calls each), Opus R1/R3 review (3 Low, pinned as limitations). **Mutation sweep not completed** (stopped for low memory), no Slither/coverage run (`forge coverage` fails with stack-too-deep) |
| L2 Shared | partly done: property tests, fund-payer guard. Nonce vectors already asserted both languages |
| L3 Indexer | partly done: net unclamped, sidecar records router/usdt/payTo, removed-log tests; Opus R1 once |
| L4 Verifier | done for the listed threats: independent decoder/rules, differential test, `--from/--to/--min-confirmations/--rpc2`, checkpoint, unanchored label, quoted-cell check |
| L5 Scripts | done: `fund-payer.ts`, `make-tampered-samples.ts` (+ tests) |
| L6 Handoff | done (`shared-change.md`) |
| L7 Docs/qualify | done: README, `WHITECHAIN_FEEDBACK.md`, `qualify-check.ts` passes all Lead items |
| L8 Whole-surface round | **not done**: no R5 fresh-eyes round, no combined closing rule |

## 2. Tests (last full run, all green)
Foundry 104 + 3 invariants + 3 expected-limitation; shared 200 (+6 property); indexer 27; relayer 281; widget 139; dashboard 13; SDK 10; demo-store 60; verifier 84 (1 live test needs `RPC_URL`; it passed). Anvil end-to-end tests need Foundry on PATH. Some new tests were written together with or after their code rather than shown red first. Mutation survivors: unknown (sweep incomplete).

## 3. Chain evidence
Router `0xb9D475cdd817900B45C356169c6FdC379B942d82`, deploy block 12351795. Payment [0x1f2da106...](https://explorer.testnet.whitechain.io/tx/0x1f2da1062f4c941382d1f0d3c7134c49858662d8eb3a68436b8f88fc7d892384), refund [0x1ac62248...](https://explorer.testnet.whitechain.io/tx/0x1ac62248eb3def54499896fd8bfc197436fcb83d9544fe94432c138c2d85127d). Live sample re-verified with a pinned range: OK, 4 events.

## 4. Attacks
Three Opus rounds' worth of Lead-surface review (see `attack-log.md`): indexer/verifier R1: 2 High, 1 Medium (fixed), 1 High accepted as design limitation, 5 Low (1 fixed, 4 open). Router R1/R3: 0 Critical/High, 3 Low accepted. Rounds R2, R4, R5 for the Lead components were not run, so the "two consecutive clean rounds" closing rule is **not met** for any component.

## 5. For A and B / for the user
See `shared-change.md` (signed net in the dashboard, refund API, zero-id rejection, x402 front-run check, real browser checkout). User: fill in the deadline; free memory and re-run the mutation sweep if wanted; hosted relayer and x402 remain unbuilt.

## 6. Model usage
Opus: 2 calls this run (indexer/verifier R1, router R1/R3). Haiku: 1 (feedback draft, reviewed). See `model-usage.md`.

## 7. Blocked / next
`blocked.md`: mutation sweep, 4 open Low verifier/indexer items. Next: re-run mutation sweep, rounds R2/R4/R5 on indexer and verifier, then a whole-system R5 pass. One housekeeping note: an earlier broad `git add` committed an untracked relayer test (`packages/relayer/test/hardening-r3.test.ts`) from Person B's folder.
