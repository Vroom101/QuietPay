# Agent client: crash-safe persisted state (stream w7)

Opt-in: `createAgent({ ..., store: { path, secret, chain, facilitator? } })`. Without `store` the
in-memory agent is unchanged. The persistent agent adds `recover()`, `reconcile()`, `close()`, `sessionId`.

## State machine
`intent` (all terms, committed BEFORE any signature) -> `signed` (signature + payload, committed before
anything leaves the process) -> `submitted` (committed before the HTTP send) -> `settled` | `failed`.
Budget is reserved inside one `BEGIN IMMEDIATE` transaction together with the intent row (sum of non-released
rows + amount <= budget). A partial unique index allows one open payment per resource.
Nonce = keccak(tag, chainId, token, from, to, value, validAfter, validBefore, keccak(resource), sessionId, counter),
so one nonce always means one set of terms. Retries resend the identical payload with
`Idempotency-Key = keccak(chainId, token, payer, nonce)`.

## Time and evidence
- validBefore = latest chain block timestamp + min(maxTimeoutSeconds - 5, 300). The local clock is never used.
- Expired = a FINALIZED block timestamp strictly greater than validBefore, read BEFORE authorizationState at `finalized`.
- Settled = successful receipt with AuthorizationUsed(payer, nonce) AND Transfer(payer -> payTo, value) on the token.
  A true authorizationState alone proves nothing (cancelAuthorization sets it): such a record is held, never settled, never released.
- The facilitator (GET /v1/x402/payments/:payer/:nonce) is advisory: it cannot release budget; a "settled"
  claim is believed only after the receipt check. Release needs finalized expiry + nonce unused + facilitator not settled/pending.
- Recovery: `signed`/`submitted` are resent unchanged; `intent` is re-signed with the SAME nonce and terms only
  if validBefore - chainNow > margin (30s), else abandoned and held until expiry. A new nonce is never created for an old payment.

## Integrity and files
Append-only event log; each event MAC (HMAC-SHA256, key derived from the caller's secret, never stored) chains to
the previous one; the `payments` table is a projection that must equal the last snapshot per nonce. Opening a
store with an edited/deleted row or event, or the wrong secret, throws `StoreError("integrity")`.
Session terms (chain, token, payer, budget, domain) are bound at creation; reopening with different terms throws `mismatch`.
A per-session lease row stops two processes driving one session.
Directory 0700, files 0600 (umask set before opening so -wal/-shm match). On Windows chmod is largely a no-op:
rely on the user profile ACL. Symlinked store file/dir, `..` segments, `:memory:` and `file:` URIs are refused.
The private key, mnemonic, store secret and RPC URLs are never written. The stored signature IS a bearer
instrument until validBefore: protect the file like a hot key.

## Known limits (documented, not hidden)
- A whole-file rollback to an older consistent copy, or deleting a consistent tail of events AND rows together
  with the secret in hand, cannot be detected from the file. `reconcile()` lists nonces the payer used on chain
  that the store does not know. Keep in the wallet no more than the budget.
- `faultInjection` and `unsafeNoLease` are test hooks.
- Not tested live: viemChainEvidence against a real node (finalized tag support depends on the RPC); only mocks and
  the pure receipt logic are covered. Whitechain finality lag affects how long budget is held after a failure.
