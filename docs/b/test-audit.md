# Backend test audit (B1)

Scope: packages/relayer, packages/merchant-sdk, packages/facilitator, apps/paid-api. Run on main at 85d47d4.
Method: Haiku helpers mapped requirements and swept weak tests (read-only); Sonnet ran coverage and shuffle and
verified the high-severity claim in the code. Full tables: `test-audit-map.md`, `weak-tests.md`.

## Requirement map (58 requirements)
KEEP 46, WEAK 6, MISSING 6.

| Id | Verdict | Gap | Severity guess |
|---|---|---|---|
| F13 | MISSING | Front-run: a third party submits the agent's authorization first, our tx reverts but the money arrived. `finish()` (facilitator/src/service.ts:401-434) marks any reverted or non-matching receipt `failed` and never checks the token `authorizationState` or the transfer log. Verified by reading the code. The payer paid but is told it failed; replay protection stops a retry with the same nonce. | High (payer misled) |
| R16 | MISSING | No reorg-after-pending test. | Medium |
| S8 | MISSING | verifyWebhook keeps no seen-id store; replay of an old signed body inside the 5-minute window is accepted. Decide: document as receiver duty or add an optional dedupe hook. | Low |
| F4, F5 | MISSING | UNIQUE(payer,nonce) and UNIQUE(tx_hash) exist in relayer/src/db.ts:209-211 but no test asserts them. | Low (test gap) |
| F18 | MISSING | No SSRF test on the x402 resource URL (operator config). Webhook SSRF is covered in relayer pentest-round2. | Low |
| R4 | WEAK | fee == value rejection (service.ts:283) has no relayer test. | Medium (test gap) |
| R19 | WEAK | payment.settled / payment.failed event `id` only proven in a skippable anvil test. | Low |
| R22 | WEAK | Only one frozen code asserted over HTTP; messages never asserted. | Low |
| R23 | WEAK | Refund funding failure tested at service level; nothing asserts that no row, spend or webhook changed. | Medium (test gap) |
| S5 | WEAK | Constant-time compare proven only by a regex on source. | Low |
| P4 | WEAK | Wrong price proven at facilitator level, not over paid-api HTTP. | Low |

Also found: merchant-sdk `src/paywall.ts` has 1.18% line coverage (no test).

## Coverage (v8, local, anvil tests running)
| Package | Lines | Branches |
|---|---|---|
| relayer | 93.9% | 89.9% |
| merchant-sdk | 41.9% (index.ts 95.3%, paywall.ts 1.2%) | 82.1% |
| facilitator | 82.1% | 82.8% |
| paid-api | 59.3% | 72.7% |

Files under 85% branch coverage: facilitator/service.ts 82.2% (uncovered branch lines 75, 89, 90, 94, 102, 123, 124, 167,
191, 210, 219, 247, 266, 277, 284, 286, 313, 334, 365, 372, 377, 404, 437, 458, 475, 476, 519, 525, 542, 606);
relayer/preflight.ts 70% (18, 27, 28, 32, 35, 42); relayer/chain-extensions.ts 83% (38); merchant-sdk/index.ts 82%;
paid-api/app.ts 80%. config.ts, main.ts, core.ts, index.ts entry files are 0% (not run in tests).

## Order and flake check
`--sequence.shuffle`, 3 runs each: relayer 358/358, merchant-sdk 43/43, facilitator 16/16, paid-api 8/8, all green, no flaky test.

## Weak-test sweep (summary)
No skip/only/todo, no assertion-free tests, no snapshot tests, no retries, no tests mocking their own subject.
Real issues: (1) relayer e2e-anvil, pentest-round3 and chain-anvil use `skipIf` with no CI guard, so a failed forge
build would silently skip the on-chain security suites; (2) pentest-round9.test.ts:345-347 asserts wall-clock time;
(3) fixed 10 ms sleeps before state checks; (4) anvil readiness loops fall through silently on timeout; (5) fixed ports.
Weak assertions: bare `.toThrow()` in merchant-sdk security tests.

## B2 queue (tests first), in order
1. F13 front-run (High): failing test at facilitator service level, then fix `finish()`/verify.
2. R4 fee == value, R23 refund no-change, R16 reorg, F4/F5 constraints, S8 decision.
3. CI guards on skipIf suites; replace fixed sleeps in guards/server tests; pin error types in SDK tests.
4. paywall.ts tests; paid-api wrong-price over HTTP.
