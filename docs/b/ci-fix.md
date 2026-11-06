# CI fix: ci / ts (push) and ci / ts (pull_request)

Cause class: (d) test setup error, two stale assumptions in one test. Not a product defect.
Test: packages/facilitator/test/anvil.test.ts, "real x402 payment path and shared checkout wallet".

Evidence
- Reproduced locally 5/5 (anvil 1.5.1-stable, forge build first). Deterministic, so not a timing race (a).
- Locally the test is skipped unless contracts/out exists; CI sets CI=1 and builds, so it runs there.
- Line 430 read db.attempts(), the legacy relay_attempts table. Since main's hardening, checkout pay
  attempts are written to tx_attempts (db.payAttempts) and their gas spend to the spend table
  (relayer/src/service.ts recordSpend). The accounting is correct; the accessor was stale.
- After fixing that, line 452 failed (4 x402 ledger rows, expected 5). The indexer scope uses
  confirmations: 2 but the test mined one block. Mining `confirmations` blocks makes it pass.

Fix (test only, no assertion weakened)
- Line 430 now asserts payAttempts(created.id) has 1 row, its hash equals the checkout tx hash,
  and a spend row exists for that hash (stronger than before: it proves loss-budget accounting).
- Mine scope.confirmations blocks before exporting the ledger.

Verification: facilitator suite 16/16 three times locally. Workspace run and CI links pending.
