# Decisions (backend audit)

- 2026-11-06: Audit work lands on branch `backend/audit-b2` (pushed every 15-20 min), not directly on `main`, so a bad commit
  cannot break main's CI. The authorised exception (CI fix to main) was already done (85d47d4). Merge to main only after the exit gate.
- Commits carry no Claude co-author trailer (user rule, overrides the default attribution).
- B0 skipped: both ci / ts checks were reported green on 85d47d4 by the user.
