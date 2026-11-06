# P0 backend implementation

Branch: `backend/remaining-build-plan`.

## Recovery and safety

The relayer signs a router-only legacy transaction and commits its signed bytes, hash,
nonce, gas limit, gas price, send time and gas reservation to SQLite before broadcasting.
A lost RPC response leaves the order pending; retries return its saved hash. Startup
releases claims that have no saved signed transaction. The monitor retries receipt
lookup and rebroadcasts saved bytes without allocating another nonce.

After `PENDING_RETRY_SECONDS`, a still-pending transaction may be replaced at the same
nonce with a rounded-up 12.5% gas-price increase. `MAX_REPLACEMENTS`, `MAX_GAS_PRICE`
and the hourly loss budget bound replacements. Original candidates remain tracked;
whichever candidate mines determines the order's transaction hash. Finalization waits
for two confirmations. Settlement, actual gas accounting and webhook enqueue share
one SQLite transaction. Pending gas reservations remain counted even after an hour.

Use one relayer process and one SQLite database per relayer wallet. Do not submit
unrelated transactions from that wallet. The database is sensitive: signed bytes can
be rebroadcast by anyone who reads them. Back it up and restrict access.

IP/order limits run before signature checks; payer/merchant limits run after signature
recovery. Payer volume is reserved at claim time and rechecked under the send lock.
Concurrent identical requests share one result. Pause prevents new sends and recovery
broadcasts while allowing receipt accounting to continue.

## Configuration

- `MAX_GAS_LIMIT=500000`: padded transaction gas limit cap.
- `LOW_BALANCE_WBT=0.01`: balance warning threshold; alerts are structured logs.
- `PENDING_RETRY_SECONDS=30`: monitor interval and minimum replacement age.
- `MAX_REPLACEMENTS=3`: maximum price bumps per transaction.
- Existing `MAX_GAS_PRICE` is in wei; an empty value leaves the price cap unset.

`GET /v1/metrics` refreshes the WBT balance and exposes `balanceWbt`, `lowBalance`,
`lowBalanceThresholdWbt`, and the combined local/on-chain pause flag.

## Live readiness

Run with Node 20 (the Docker image uses Node 20). Populate environment variables in
the hosting provider or local shell. `pnpm --filter @quietpay/relayer preflight` is read-only:
it checks chain ID, deployed code, router token, six decimals, relayer allowlist,
merchant registrations and funded gas balance. Startup runs the same checks.

Follow `docs/lead/deploy.md` to deploy/register/verify the router, synchronize deployment
addresses, and host the service with a persistent `/data` disk. The Render blueprint
includes recovery settings. The host must run a single replica for this wallet.

Run the first-payment script with `RPC_URL`, `RELAYER_URL`, `QUIETPAY_API_KEY`,
`QUIETPAY_MERCHANT_ID` and `PAYER_PRIVATE_KEY` set locally. Optionally set
`FIRST_PAYMENT_WEBHOOK_URL` to the merchant receiver. The script checks that the payer
holds zero WBT before and after settlement. Confirm webhook delivery at the merchant,
then record the transaction and verified contract links in the README.

Live deployment, explorer verification, funded-wallet execution and hosted webhook
proof remain pending until accounts and funded wallets are configured. A local test
pass does not satisfy these live gates.

## Validation

Validated using Node 20: workspace typechecks, workspace tests and workspace builds
pass. The final relayer suite has 68 passing tests (32 added for P0). The Anvil test
is skipped locally because Foundry/contract artifacts are unavailable; CI builds
those artifacts and the test explicitly mines the second confirmation block.
No live deployment or testnet payment was performed.
