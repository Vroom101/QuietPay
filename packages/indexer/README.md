# Quietpay ledger, export and verifier

This read-only service rebuilds accounting from PaymentRouter Paid, Refunded and merchant
registry events. It uses no relayer database or gas wallet. A separate verifier scans the
RPC independently and compares the declared export with canonical chain events.

## Accounting

The API returns order summaries: gross, relay fee, refunded, net, refund count and status.
Amounts are exact six-decimal strings, calculated with bigint. Full refunds include the
customer's original price, so the merchant's final net can be negative by the relay fee.

CSV is an event journal, one row per payment/refund/direct transfer, keyed by transaction
hash plus log index. Payment rows record gross and fee; refund rows record only that
refund's amount and negative net. Do not sum gross again on refund rows. Order summaries
are separate from these journal entries. This keeps refund-only date/block ranges complete.

Columns: date_utc, source, order_id, merchant_id, payer, gross_usdt, relay_fee_usdt,
refunded_usdt, net_usdt, status, tx_hash, block, log_index.

Optional FACILITATOR_PAYTO plus FACILITATOR_MERCHANT_ID enables USDT Transfer accounting
to that recipient, labeled source=x402. Router-originated transfers are excluded to avoid
counting merchant payouts twice. These are observed transfers, not proof that an API call
was delivered. The facilitator is implemented in packages/facilitator. The payTo cannot be the router.

## Run

Use Node 20 and the root pnpm workspace. Set variables in the shell or hosting environment;
.env.example is a reference and is not loaded automatically.

Required: RPC_URL, CHAIN_ID, ROUTER_ADDRESS, USDT_ADDRESS and INDEXER_FROM_BLOCK (the
actual router deployment block). The service checks chain ID, router token and six decimals.
For HTTP, set MERCHANT_API_KEYS to the same apiKey:merchantId mapping as the relayer.
CLI export/verification does not require merchant keys or any private key.

Defaults: INDEXER_DATABASE_PATH=./quietpay-indexer.db, INDEXER_CONFIRMATIONS=2,
INDEXER_POLL_MS=5000, INDEXER_PORT=8788. Only blocks at or below head minus the configured
confirmation depth are indexed. The database must be distinct from the relayer database.

```powershell
pnpm --filter @quietpay/indexer start
pnpm --filter @quietpay/indexer cli sync
pnpm --filter @quietpay/indexer cli export --out ./export --merchant 0xYOUR_MERCHANT_ID
pnpm --filter @quietpay/indexer cli verify --csv ./export.csv --meta ./export.meta.json --merchant 0xYOUR_MERCHANT_ID
```

Export writes export.csv and export.meta.json and refuses to overwrite existing files.
Use --from N and --to N for a block range. CLI sync/export catches up fully; each HTTP
sync is limited to 20 pages. GET /v1/health exposes indexedThrough, head and caughtUp.
Backfills can serve an honest earlier checkpoint, but cannot export beyond indexed progress.
A Dockerfile is included; mount /data persistently and configure the variables above.

## HTTP API (separate service, port 8788)

All ledger endpoints require Authorization: Bearer <merchant API key>. Merchant selection
comes from the key, not a query parameter. Each merchant sees only its own rows and totals.

- GET /v1/health: public indexing progress and last sync error.
- GET /v1/ledger?limit=100: order summaries, latest event rows and full-history totals.
- GET /v1/ledger/export?fromBlock=N&toBlock=N: JSON containing csv and meta; save both.
- POST /v1/ledger/verify: body {csv, meta}; returns ok, five counts, offending rows/fields
  and the independently calculated checkpoint. An altered export returns 200 with ok=false;
  invalid/unverifiable input returns an error. Another merchant's export is rejected with 403.

The API is read-only. It does not modify order/payment/refund state in the relayer.

## Verification and trust boundary

Metadata includes schema version, chain ID, router, token, deployment block, declared block
range, confirmation depth, merchant filter, optional agent attribution, end block hash,
event-set hash and generation time. Configure those contracts and the RPC independently.
The verifier rejects changed scope or weaker confirmation requirements, reads pre-range
payment history to validate refunds, and compares every expected event row.

It reports matched, altered (with field differences), missing, extra and duplicate rows.
A second duplicate cannot hide tampering behind a clean first copy. Metadata event and
block hashes are checked against RPC data. The checkpoint contains the range, event count
and event-set hash so a rebuild can be compared.

Completeness means completeness within the declared range and merchant scope. An attacker
could deliberately supply a narrower period; auditors should agree the period independently
and use CLI --from/--to/--merchant or the library's expected range arguments to pin it.
The result trusts the configured RPC's view of the chain. Fixed-depth confirmation does not
provide an absolute finality guarantee; a reorg during a scan causes a retry/error.

## Persistence and reorgs

Events and canonical event/page-boundary block hashes commit with the cursor in one SQLite
transaction. Duplicated logs are ignored, conflicting logs rejected. On each sync, the stored
tip hash is checked; if it changes, the indexer walks stored checkpoints to a common ancestor,
deletes orphaned data and replays. A larger confirmation depth or shorter head also rolls
back unsafe progress. A page whose hashes change mid-read is not committed.

Deleting/rebuilding the index database yields the same CSV and event-set hash for a stable
range. Run one indexer process per index database; verification never needs that database.

## Tests

Run pnpm --filter @quietpay/indexer test and pnpm --filter @quietpay/indexer typecheck.
The unit tests cover 1,000-block paging, confirmation depth, duplicate/conflicting logs,
restarts, RPC failures, reorgs, exact amounts, CSV parsing and all five verifier outcomes.
Anvil integration deploys actual contracts, pays/refunds, adds a direct transfer, verifies
HTTP/CLI exports, catches tampering, reverts chain state and confirms the rebuilt ledger.
Set ANVIL_BIN if Anvil is not on PATH; build contracts first. CI requires the integration.
Live Whitechain exports and UI integration are still pending deployment.

### Current validation

The indexer package has 30 passing tests, including its real Anvil/HTTP/CLI integration.
At the ledger checkpoint, the workspace had 180 passing tests with both then-existing Anvil integrations enabled; workspace
typechecks and app/widget builds pass. No contracts were changed by this feature.
These results use local test contracts, not a live Whitechain deployment.

The subsequent x402 implementation brings the workspace total to 211 tests and three Anvil integrations.
