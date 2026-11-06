# Decisions (backend audit)

- 2026-11-06: Audit work lands on branch `backend/audit-b2` (pushed every 15-20 min), not directly on `main`, so a bad commit
  cannot break main's CI. The authorised exception (CI fix to main) was already done (85d47d4). Merge to main only after the exit gate.
- Commits carry no Claude co-author trailer (user rule, overrides the default attribution).
- B0 skipped: both ci / ts checks were reported green on 85d47d4 by the user.
- R16: confirmation depth is opt-in (SETTLE_CONFIRMATIONS, default 1) so existing deployments keep their behaviour. Recommend setting it above 1 for Whitechain before real money; the right value depends on the chain's finality, which is not documented here.
- S8: verifyWebhook stays stateless by default; added optional isDuplicate(eventId) hook, called only after the signature and timestamp verify. Receivers must still dedupe by event id (documented on the option).
- F18: the facilitator and paywall never fetch a URL taken from a request, payload or resource (proved by a no-fetch test), so there is no SSRF surface there; webhook URL SSRF stays covered by relayer ssrf-ipv6 and pentest-round2 tests.
