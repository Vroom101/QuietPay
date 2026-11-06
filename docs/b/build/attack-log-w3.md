# Attack log, stream w3 (hosting)

| # | Finding (hypothesis) | Severity | Status |
|---|---|---|---|
| 1 | Webhook delivery validates DNS then fetch() resolves again: a rebinding resolver (public at validation, private at connect) reaches an internal address | Medium | Fixed: delivery connects only to the addresses validated for that delivery (packages/relayer/src/webhook-pin.ts, `pinConnections` on in the relayer and facilitator entries). Test: build-webhook-pin.test.ts |
| 2 | Two relayer processes on one database collide on the signing nonce | Medium | Fixed: exclusive lock file `<db>.lock`, stale-safe. Test: build-instance-lock.test.ts (two child processes) |
| 3 | A backup taken by copying the live file can be torn (WAL) | Medium | Fixed: online backup API, integrity_check, sha256. Test: build-db-backup.test.ts |
| 4 | Restoring a database from another chain or router, or a modified file | High | Fixed: identity recorded in `settings`, restore refuses mismatch, missing identity, checksum mismatch, non-database, missing tables, running relayer |
| 5 | Demo-store server (merchant server) had no explicit body limit or request/connection/headers timeouts | Low | Fixed: 64 KiB body, 30 s request, 60 s connection, 15 s headers (apps/demo-store/server/app.ts) |
| 6 | Indexer ledger API had a body limit but no timeouts | Low | Fixed: 30 s request, 60 s connection, 15 s headers (packages/indexer/src/api/server.ts) |
| 7 | Unauthenticated /v1/metrics and /v1/admin/* | n/a | Rejected: 14 request variants all refused (build-attacks.test.ts) |
| 8 | Error bodies leaking stack, path, secret | n/a | Rejected: malformed, oversize, mistyped and thrown-exception cases return fixed bodies on relayer, facilitator, paid API, demo store, indexer |
| 9 | Health leaks secret or database path | n/a | Rejected: exactly ok, chainId, router, token, relayer, paused, blockNumber |
| 10 | Spoofed X-Forwarded-For resets a rate limit | n/a | Rejected: ignored at TRUST_PROXY_HOPS=0; at 1 only the proxy-appended entry counts |
| Residual | Lock liveness uses the pid; a reused pid after a hard crash looks live (delete the .lock). Backups on the same disk as the database do not survive disk loss (see runbook for off-disk copy) | Low | Documented |
