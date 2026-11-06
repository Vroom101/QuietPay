# Harmony log (conflicts with the audit session)
| Time (UTC) | File | Conflict | Resolution |
|---|---|---|---|
| W2 merge | `packages/relayer/src/preflight.ts` | audit added an `isEntryPoint(...) await main()` guard at the end; W2 added re-exports from `preflight-checks.ts` at the same place | kept both blocks; relayer 503/503 and typecheck green afterwards |
