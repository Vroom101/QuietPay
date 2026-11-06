# L0 reconcile (2026-11-06)

Baseline before this run: Foundry 104 pass / 1 skipped (fork, offline); shared 193, indexer 26, relayer 259, widget 139,
dashboard 13, SDK 10, verifier 55 (+1 live test skipped offline), demo-store 60. Typecheck clean.

States: done+tested, done/untested, partial, missing. Only the last three become work.

| Item | State | Evidence / gap |
|---|---|---|
| Fee inside pay nonce (v2) | done+tested | `quietpay.pay.v2`, `shared/fixtures/nonce-vectors.json` asserted both languages |
| `fee >= value` rejected | done+tested | PaymentRouter.sol:264, hardening tests |
| `setRefundSigner` + event | done+tested | PaymentRouter.sol:125 |
| Balance-delta check on pulls | done+tested | PaymentRouter.sol:285-290 |
| Rollback tests (payout/fee/refund transfer fail) | done+tested | `mocks/BadTokens.sol`, Hardening/Refund tests |
| Signature length tests | done+tested | PaymentRouterHardening.t.sol |
| Fuzz tests | done+tested | refund cap fuzz, fee edge fuzz |
| Invariant tests (balance delta, totalRefunded <= value, fee < value) | **missing** | no `invariant_` functions exist -> L1 |
| Slither / forge coverage / mutation sweep | **missing** | never run -> L1 |
| Stand-in token / DemoUSDT left | done+tested | only in history notes of `deployments.json` and docs |
| Shared: strict `parseUsdt`, exact `formatUsdt` | done+tested | `amount.ts`, 83 amount tests |
| Shared: property tests (fast-check round trip) | partial | example tests only -> L2 |
| `assertQualifyingConfig` | done+tested | `qualifying.ts` |
| Mock relayer refund route | done+tested | `mock-server.ts` |
| ABI generated not copied | done/untested | `shared/src/abi` |
| DeployQualifying guards chain+token | done+tested | `DeployScripts.t.sol` |
| Indexer: payto_transfer double-count rule | done+tested | `ledger.ts`, ledger tests |
| Indexer: page 1000 + halve on -32062 | done+tested | `rpc.ts` |
| Indexer: `removed:true` logs ignored | done/untested | `rpc.ts:105` filter, no dedicated test -> L3 |
| Indexer: deep reorg fails loudly | done+tested | `indexer.ts` cursor-hash check |
| Indexer: byte-identical repeat export, `rebuild` | done+tested | indexer tests |
| Net on full refund | **partial** | code clamps `max(0, ...)`; frozen text says `value - fee - refunded` -> L3 decision |
| Verifier: five result classes | done+tested | extra/missing/wrong_* codes in `verify.ts` |
| Verifier: independent decode + row builder | **missing** | `verify.ts` imports `decodeRouterLog`, `buildLedgerRows`, `eventSetHash`, `getLogsPaged` from the indexer -> L4 |
| Verifier: expected range outside meta (`--from/--to`) | **missing** | CLI reads range only from the sidecar -> L4 |
| Verifier: `--rpc2` cross-check | **missing** | -> L4 |
| Verifier: non-zero exit on mismatch, JSON output | done+tested | `run.ts` (exit 1, `--json`) |
| Verifier: differential property test vs indexer | **missing** | -> L4 |
| `scripts/` (fund-payer, tampered samples, qualify-check) | **missing** | `scripts/` is empty -> L5, L7 |
| `WHITECHAIN_FEEDBACK.md` | **missing** | -> L7 |
| README two why-onchain lines | partial | check in L7 |
| Pen-test findings mapped to regression tests | done/untested | `PenTestRouter.t.sol`, `pentest-round*.test.ts`; map in L8 |

Contract change gate: deadline placeholder not filled, so contracts are treated as frozen (no redeploy). Known
accepted router finding (payout may equal the router) stays an `expected-limitation`.
