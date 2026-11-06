# Attack log, stream w7 (agent-client store)

| Finding / hypothesis | Severity | Status |
|---|---|---|
| retry(id) could replay a signed authorization after validBefore | Medium | Fixed: retry checks chain time first; test "never replayed after expiry" |
| Facilitator lies "failed" while the chain shows the nonce used | High | Rejected by design; test: budget unchanged until receipt evidence, then settled |
| Facilitator "settled" with foreign/wrong-payTo/wrong-value tx | High | Held, never settled (test, 3 variants) |
| cancelAuthorization makes authorizationState true | High | Held, neither settled nor released (test) |
| Resource server claims success with a fake tx | High | Not believed: receipt required (test) |
| Local clock skew shortens/extends validBefore | Medium | validBefore uses chain time (test with far-future chain time) |
| Huge maxTimeoutSeconds | Medium | Capped at 300s (test; schema already caps 600) |
| Release too early (finalized == validBefore, or authorizationState read before the finalized time) | High | Strict `>`; finalized time read first (test) |
| Store edits: lower amount, delete row/event, flip released, forge payee, wrong secret | High | Integrity error on open (13 cases) |
| Whole-file rollback to an old backup | High | Not detectable from file; nonces stay bound to terms (test); `reconcile()` surfaces unknown spends. Residual risk documented |
| Terms changed after restart (budget/payer/token/chain/domain; server amount/payTo) | High | mismatch / invalid_payment, nothing signed (tests) |
| Path traversal, symlinked file/dir, :memory:, file: URI, NUL | Medium | Refused (tests) |
| SQL injection via resource | Medium | Parameterised statements; verbatim storage (test) |
| Nonce reuse across sessions | High | Session id is part of the nonce (test) |
| Two processes exceed budget | High | BEGIN IMMEDIATE (3 racing processes -> 1 intent) + lease (tests) |
| Secrets in store/logs | High | None found in db/wal/shm or console (test) |
| Windows file permissions | Low | Open: chmod is weak on Windows, documented |
