# Remaining backend work: reconcile (W0)

Branch `backend/remaining-build` = `backend/remaining-build-plan` + `origin/main` + `origin/backend/audit-b2` (audit session, incl. the F13 fix), all merged cleanly. Baseline on the merged result, all green: relayer 366, facilitator 32, SDK 59, paid API 11, shared 279, indexer 86 (+1 skipped), verifier 179 (+3 skipped); typecheck clean.

| # | Item | State | Evidence / gap |
|---|---|---|---|
| 1 | Router deployment state | **done on chain, test missing** | `cast` reads on chain 1874 (see `deployment-state.md`). No automated read-only test asserts the registration. |
| 2 | Configuration, funding, preflight | **partial** | `packages/relayer/src/preflight.ts` is 45 lines and checks little; no stable codes, JSON mode, token-domain or merchant-registration checks, no fund-check script. Wallets are funded. |
| 3 | Hosting | **partial** | `render.yaml` and `render.facilitator.yaml` exist. Missing: `deploy/`, backup and restore, instance lock, webhook IP pinning (`webhooks.ts` documents the DNS-rebinding window as a residual risk), deployed services. Hosting login not verified here. |
| 4 | Live end-to-end proof | **partial** | The Lead's router-level live payment and refund exist (official USDT). No `deploy/e2e.mjs`, no backend-path live evidence (relayer -> webhook -> refund -> verify). |
| 5 | Customer refund status | **missing** | Only `packages/shared/src/webhook.ts` knows `payment.refunded`; no demo-store refund-status endpoint or store. |
| 6 | x402 interoperability | **partial** | Facilitator and paid API exist; F13 front-run fix merged from the audit branch. Missing: official-client check, `GET /v1/x402/payments/:payer/:nonce`, live paid call. |
| 7 | Persisted agent state | **missing** | `packages/agent-client/src` is a single `index.ts` with no store. |
| 8 | Documentation | **partial** | Several README rows and `docs/b/*` are stale relative to the merged code. |

Live wallets (chain 1874): relayer 50.3 WBT, owner 1.68 WBT, refund signer 50 WBT and 99.5 USDT (see deployment-state). Payer holds only 9.99e-9 WBT dust and 99.5 USDT.
