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
