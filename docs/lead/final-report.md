# Final report (Lead finish run, 2026-11-06)

"No findings" means not found by these methods, never proven safe. Nothing here is an audit.

## 1. Tasks
| Task | State |
|---|---|
| T0 resume, baseline | done |
| T1 a-d (RefundSignerChanged + hashVersion 2, strict CSV, full --rpc2, same-tx deposit rule) | done, tests first, live sample regenerated and verified |
| T2 router assurance | done: mutation sweep 58/60 killed, 2 survivors killed by new tests; coverage (97.7% lines, 80% branches, gaps tested); Slither run (1 justified note); attack rounds R2 and R4 |
| T3 indexer + verifier rounds | done: R2 (6 DoS holes) and R4 (9 holes incl. High RPC-key leak) fixed; earlier R1 findings have regression tests |
| T4 handoff | done (`shared-change.md`); stray `hardening-r3.test.ts` is B's |
| T5 final round | done: anvil end-to-end (two refunds across a signer rotation, anchored verify, tampered variants, legacy hash version, re-index match); fresh-eyes R5 found 3 holes, fixed |

## 2. Tests (last full run, all green)
Foundry 130 (+1 fork skipped offline); shared 279; indexer 88; verifier 181 (+1 live test, which passed with RPC_URL); relayer 358 (alone; two tests time out when all packages run in parallel); SDK 43; widget 147; demo-store 75; dashboard 34; agent-client 22. Typecheck clean. Some tests were written alongside or after their code, not always shown red first. Router mutants: 58 killed, 2 survived and are now killed; 60 is a sample, not every mutant.

## 3. Chain evidence
Router `0xb9D475cdd817900B45C356169c6FdC379B942d82`, deploy block 12351795, official USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`. [Payment](https://explorer.testnet.whitechain.io/tx/0x1f2da1062f4c941382d1f0d3c7134c49858662d8eb3a68436b8f88fc7d892384), [refund](https://explorer.testnet.whitechain.io/tx/0x1ac62248eb3def54499896fd8bfc197436fcb83d9544fe94432c138c2d85127d). Live ledger sample re-verified against chain 1874 with the range pinned: OK. No demo or stand-in token is used anywhere in code (checked repo-wide).

## 4. Attacks
Rounds run on Lead components: router R1/R3 (earlier), R2, R4; indexer+verifier R1, R2, R4, plus R11 and R5 fresh eyes. Findings were always found, so the "two clean rounds" closing rule is **not met** for any component. By severity this run: High 4 (net clamp, payto-less verify, owner powers [documented], RPC-key leak), Medium ~10, Low ~20; all fixed or documented except below. Rejected hypotheses: fake token/contract forging a row; SQL injection; prototype pollution.
Open: router owner can redirect future payouts instantly (README + test); relayer gas griefing by a payer (bounded off-chain); payout legs not balance-checked; plain Ownable lock; zero ids accepted; no memory cap on huge CSV/RPC response; dependency advisories (fastify, zod, vite) need major upgrades; CI actions pinned by tag and Foundry unpinned.

## 5. For others / the user
A and B: `shared-change.md` (signed net in the dashboard, refund API, zero-id rejection, fastify upgrade, merge before touching the four backend files Lead edited at the owner's request). User: set `SUBMISSION_DEADLINE_UTC` (contracts stay frozen without it), decide on a new router if owner powers matter, push or discard `backend/remaining-build-plan` commit `0d9cca5` (local only). Backups `backup/pre-trailer-*` hold pre-rewrite history (local); delete when satisfied.

## 6. Model usage
Opus 6 of 8 (design gate, router R2/R4, indexer+verifier R2/R4, fresh eyes); Sonnet subagents 5; Haiku 0 this run. Logs of tools and sweeps stayed in files.

## 7. Blocked / next
`blocked.md`: dependency upgrades, CI pinning, Low items. Not built: hosted relayer, real browser checkout, live x402 evidence. Next: set the deadline, upgrade fastify/zod, pin CI, then a human review.
