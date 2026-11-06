# Backend audit: final report (branch `backend/audit-b2`)

## 1. Exit gate verdict
| Gate | Verdict |
|---|---|
| CI green on `ci / ts (push)` and `ci / ts (pull_request)` | **Not confirmed.** `gh` is not installed here. The branch is pushed; a person has to read both checks. Local equivalent below is green. |
| F13 closed with a real front-run test on anvil | Pass. `anvil-front-run.test.ts` fails on the old code (`failed`), passes now (`settled`). |
| All 58 requirement rows KEEP | Pass: 6 weak + 6 missing rows all closed. |
| Route matrix passes for every route | Pass (relayer, facilitator, paid API; 18 + 3 routes). |
| Coverage targets | Pass (section 3). `merchant-sdk/src/index.ts` is 83.6% branches, a client file, not a guard. |
| Mutation survivors zero or justified | Pass: 43 mutants, 38 killed, 5 survive, each justified as equivalent (`mutation-results.md`). |
| Two clean attack rounds | **Fail.** Rounds A and C each found valid issues (fixed). Max three rounds reached; two items stay open (below). |
| No secrets in tree or history | Pass (0 real; only anvil default keys in tests). |
| Anvil suites fail loudly in CI | Pass (`requireInCi`, port and readiness checks). |
| Local runs | `pnpm -r typecheck` x3 green. `pnpm -r test` (CI style) x3 green. Shuffle green on all 4 backend packages. `pnpm -r --parallel test` is **not** reliably green on this machine: 3 slow tests (relayer refunds, relayer R4 nonce hole, indexer ledger API) exceed vitest's 5 s default under 12-way load; each passes alone in under 2 s. Indexer and shared tests are not mine; noted in `needs-from-others.md`. |

## 2. Audit totals
58 requirements mapped; 12 gaps found (6 weak, 6 missing); 12 closed. Four coverage/hygiene groups added: anvil guards and polling, entry-file smoke tests, specific error assertions, property tests (fast-check).

## 3. Coverage (lines / branches), before to after
relayer 94/90 to 94.7/90.6; merchant-sdk 42/82 to 93/87 (`paywall.ts` 1% to 92%); facilitator 87/83 to 87/91 (`service.ts` 82% to 91.4% branches); paid-api 59/73 to 68/90 (`app.ts` 94.7% branches); relayer `preflight.ts` 92.6% branches. Test counts: relayer 418, facilitator 185, merchant-sdk 69, paid-api 37.

## 4. Attack summary
Findings fixed: High 2 (F13 front-run, A-F2 recovery after expiry), Medium 4 (R16 reorg depth, M1 wildcard CORS on authenticated routes, A-F4 x402 reverts uncounted, C-F2 first-time pool), Low/Medium 3, Low 7. Opus rounds A, B, C: 5 + 8 + 5 hypotheses, about half rejected after reading the code. **Open:** A-F1 (High, spec): a settled x402 payload is public calldata, so whoever replays it first can take a pending delivery; needs a requester binding in the frozen spec. C-F1 (Medium, product): parallel sends from one wallet are bounded only by the global hourly loss budget. Known limits: forwarder/multicall settlements park as `unresolved`; the signature does not cover the resource; USDT blacklist is out of scope. A clean round is not proof of absence.

## 5. For others (`needs-from-others.md`, `blocked.md`)
Set `CORS_ORIGINS` for the browser dashboard; demo-store pins Fastify 4 (advisories); zod 3 to 4 decision (high advisory, mitigated by 16 KiB body caps); A-F1 spec decision; C-F1 in-flight cap decision; indexer test flakes under load. Needs you: confirm CI on the branch and decide the merge to `main` (not done; I did not push to `main`).

## 6. Calls
Opus 4 of 7 (F13 design gate, rounds A, B, C). Haiku 5 (requirement maps, weak-test sweep, route matrix, dependency and secret scan). Sonnet: main session. Test, coverage and mutation logs were kept in files outside the conversation.

## 7. Not done in this run
Hosting the relayer (`render.yaml` ready), a real browser checkout against the deployed router, live x402 evidence.

**Safe to proceed? Conditionally.** Blockers: (1) confirm both CI checks on this branch; (2) decide A-F1 before exposing x402 to real value; (3) decide the merge to `main`.
