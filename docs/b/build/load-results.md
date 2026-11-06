# Load measurement (local anvil, one relayer process, 2026-11-07)

Real relayer entry (`packages/relayer`), SQLite, local anvil with instant blocks, on a developer laptop. Not the testnet and not a hosted machine: treat as relative, not as a capacity promise. Run: `E2E_PORT_BASE=8900 node --import tsx packages/e2e/src/load.ts`.

| Test | Concurrency | Result |
|---|---|---|
| GET /v1/orders/:id | 50 | ~2,000 req/s, p50 19-24 ms, p99 55-62 ms, all 200 |
| GET /v1/health | 50 | ~1,400-1,800 req/s answered, but only 59 were 200: the rest got 429 (per-IP limit on health) |
| POST /v1/orders from one IP | 20 | 119 created, the rest 429: hard per-IP cap of 120 per minute |
| End-to-end payments (distinct payers/orders) | 5 / 20 / 50 | all accepted and settled: 6 / 11 / 15 payments per second (instant blocks) |

Findings
1. Order creation is capped at 120 per minute per client IP (hard-coded `ordersLimiter` in `packages/relayer/src/server.ts`). Every merchant server calls from one IP, so one merchant is limited to about 2 orders per second. This is the first bottleneck for an API fronting real traffic. Fix: limit per authenticated API key, configurable, keep the per-IP limit for unauthenticated calls.
2. The health route returns 429 after about 60 calls from one IP. A load balancer or monitor probing often from one address would be throttled.
3. On the real chain throughput is bounded by one relayer key: transactions go out in nonce order, and each needs a block. Measured 15 per second is with instant blocks and does not apply to the testnet.
4. One process and one SQLite file per relayer key (a deployment invariant): scale up, not out.

## After the fix (same machine, same method)
Valid API keys are now limited per merchant (`ORDERS_PER_MINUTE_PER_MERCHANT`, default 1200) instead of per IP. Invalid or missing keys keep the per-IP 120/min throttle and the failed-auth throttle. POST /v1/orders from one IP: 1,084 created in 4 s (about 270/s; before: 119 created, the rest 429). Reads: about 4,300 req/s (p99 39 ms). Health stays at 60 per minute per IP (monitors should poll at most once per second). The same cap still applies once per merchant per minute.
Tests: `packages/relayer/test/build-load-limits.test.ts` (5). One earlier test (`pentest-round10` R10-A1) now raises the cap in its setup because its 10,000-request fill is otherwise throttled; its assertion is unchanged.
