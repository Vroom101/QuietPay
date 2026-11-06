# Blocked and pending items

| Item | Status | What is needed |
| --- | --- | --- |
| `main` is red in A's and B's packages | **by design until they merge** | `packages/relayer/src/service.ts` needs `fee` in `computePayNonce`; `apps/merchant-dashboard` test expects the old two-decimal format. Listed in `docs/lead/shared-change.md`. Lead does not edit their folders. |
| Leftover stand-in token reference | A/B folder | `packages/relayer/test/e2e-anvil.test.ts` (listed for B). |

## Open Low items from L3/L4 R1 (not fixed yet)
- `RefundSignerChanged` is decoded by neither tool, so it is absent from the event-set hash although it changes who funds refunds. Fixing it changes the hash, so exports made before must be regenerated.
- `parseCsvLine` accepts quoted cells such as `"router"`; the exporter never emits them.
- `--rpc2` cross-checks ledger logs only; head, timestamps and settlement-tx Transfers come from the primary node.
- A contract relayer that puts a pay-to deposit in the same transaction as a `pay` or `refund` hides it under the double-count rule.

## Router mutation sweep not completed
`scripts/mutate-router.py` ran for about 35 minutes and was stopped by Claude Code because the machine was critically low on memory (each mutant recompiles the router with viaIR and runs the suite). No survivor list exists, so "zero surviving mutants" is NOT claimed. To finish: close other programs, then run `python scripts/mutate-router.py` (consider running forge with `--no-match-test invariant` and a lower `FOUNDRY_FUZZ_RUNS`). Not restarted automatically.

## Dependency audit (T3-R4, 2026-11-06): `pnpm audit` = 28 findings (3 critical, 8 high)
Critical: `vitest <3.2.6` and `tinypool` (test runner only, never shipped). High, reachable in shipped code: `fastify` (<5.12.2; relayer, B), `find-my-way` (<=9.6.0, via fastify), `zod` (<4.6.6; shared + others), `vite` (<=6.4.3; dev server of the demo store). Fixes are major-version upgrades (fastify 4 to 5, zod 3 to 4, vitest 2 to 3) that touch every package and were not attempted blind. Next step: B upgrades fastify and the relayer tests; Lead upgrades zod in `packages/shared` behind its 250 tests, then everyone re-runs `pnpm -r test`. Running the relayer behind the Render proxy with `TRUST_PROXY_HOPS=1` does not mitigate these.

## CI pinning (R4, Low)
`.github/workflows/ci.yml` pins actions by tag, not commit SHA, and `foundry-toolchain@v1` has no `version:`, so CI uses the current Foundry rather than the one the router was built with. Not changed here: the backend session owns the in-flight CI fix for the facilitator test and pinning Foundry could change its behaviour. Next step: pin a Foundry version and action SHAs together once CI is green.
