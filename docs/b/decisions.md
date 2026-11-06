# Decisions (backend audit)

- 2026-11-06: Audit work lands on branch `backend/audit-b2` (pushed every 15-20 min), not directly on `main`, so a bad commit
  cannot break main's CI. The authorised exception (CI fix to main) was already done (85d47d4). Merge to main only after the exit gate.
- Commits carry no Claude co-author trailer (user rule, overrides the default attribution).
- B0 skipped: both ci / ts checks were reported green on 85d47d4 by the user.
- R16: confirmation depth is opt-in (SETTLE_CONFIRMATIONS, default 1) so existing deployments keep their behaviour. Recommend setting it above 1 for Whitechain before real money; the right value depends on the chain's finality, which is not documented here.
- S8: verifyWebhook stays stateless by default; added optional isDuplicate(eventId) hook, called only after the signature and timestamp verify. Receivers must still dedupe by event id (documented on the option).
- F18: the facilitator and paywall never fetch a URL taken from a request, payload or resource (proved by a no-fetch test), so there is no SSRF surface there; webhook URL SSRF stays covered by relayer ssrf-ipv6 and pentest-round2 tests.

- B2.3 relayer anvil suites: fixed ports (18545/18546 etc.) kept but guarded by `assertPortFree` (fails with a clear message on a stale anvil) and `waitForRpc` (throws on timeout). Full port-0 conversion deferred: the e2e suite hands the port to child processes and config, so the guard gives the same safety for less churn.
- B2.3 `pentest-round9`: the wall-clock `<350ms` assertion is replaced by a count of worker passes (<=2), which tests the same fairness property without timing.

- B2.4 CORS: public routes keep `*` (the browser widget calls order status and relay/pay). Authenticated routes get no CORS headers unless the origin is listed in the new `CORS_ORIGINS` env. This protects the bearer-token routes by default; the merchant dashboard (Person A) calls `GET /v1/orders` from the browser and now needs its origin listed (see needs-from-others.md).
- B2.4 unknown routes return `{error:{code:"not_found"}}`; `not_found` is not one of the frozen shared ErrorCodes, so it is sent as a raw body outside the shared schema. The widget never produces unknown routes, so the contract is unaffected.
- B2.4 `GET /v1/orders/:id` still has no route-level limiter (it returns only public order data and ids are 32 random bytes); recorded, not changed.
