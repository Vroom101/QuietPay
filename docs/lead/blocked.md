# Blocked and pending items

| Item | Status | What is needed |
| --- | --- | --- |
| Live indexer sample for the qualifying router (Phase 4 real run) | **pending** on the two items above | The sample export needs a real payment and refund on the qualifying router. Only anvil tests run until then. |
| `main` is red in A's and B's packages | **by design until they merge** | `packages/relayer/src/service.ts` needs `fee` in `computePayNonce`; `apps/merchant-dashboard` test expects the old two-decimal format. Listed in `docs/lead/shared-change.md`. Lead does not edit their folders. |
| Leftover stand-in token reference | A/B folder | `packages/relayer/test/e2e-anvil.test.ts` (listed for B). |
