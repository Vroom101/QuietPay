# Deploy runbook (testnet, Whitechain Sepolia 1874)

Status: built and tested, NOT deployed. No hosting credential was available (`flyctl auth whoami` failed, `RENDER_API_KEY` unset). Every step marked **needs user** needs your account. Official test USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` and router `0xb9D475cdd817900B45C356169c6FdC379B942d82` only. No production custody, no audit claim.

## What is in the repo

| Piece | File |
|---|---|
| One workspace image (Node 20.18.1, pnpm 10.0.0, `--frozen-lockfile`), start command per service | `deploy/Dockerfile`, `deploy/start.sh` |
| Full Render blueprint: relayer+facilitator (1 instance, disk, `/v1/health`), paid API, merchant server, indexer ledger API | `deploy/render.yaml` |
| Older per-service blueprints, env names added additively | `render.yaml`, `render.facilitator.yaml` |
| Post-deploy smoke test | `deploy/smoke.mjs` |
| Database backup / restore | `pnpm --filter @quietpay/relayer backup` / `restore` (`packages/relayer/src/db-cli.ts`) |

Not verified here: `docker build` (the Docker engine was not running on the build machine). Run the build once locally before the first deploy (step 1).

## 1. Build the image locally (optional check)

```
docker build -f deploy/Dockerfile -t quietpay-backend .
docker run --rm quietpay-backend nonsense        # prints the usage line, exit 2
```

## 2. Create the services on Render (needs user)

1. Push the branch to the repository Render can read (needs user; not done here).
2. Render dashboard, New, Blueprint, pick the repo, set the Blueprint path to `deploy/render.yaml`. Render creates four web services over HTTPS: `quietpay-relayer`, `quietpay-paid-api`, `quietpay-merchant-server`, `quietpay-indexer-api`.
3. Fill the secret values (all `sync: false`, set in the dashboard, never in git). Names only:

| Service | Secret names |
|---|---|
| quietpay-relayer | `RELAYER_PRIVATE_KEY`, `OPERATOR_TOKEN` (16+ chars), `MERCHANT_API_KEYS` (`apiKey:0x<bytes32>` pairs, each key 24+ chars), `WEBHOOK_SECRET` (16+ chars) |
| quietpay-relayer (non-secret, still yours to set) | `PAID_API_PUBLIC_URL`, `FACILITATOR_PAYTO`, `FACILITATOR_MERCHANT_ID`, `MAX_GAS_PRICE`, `CORS_ORIGINS` |
| quietpay-paid-api | `QUIETPAY_API_KEY`, plus `PAID_API_PUBLIC_URL`, `FACILITATOR_URL`, `FACILITATOR_PAYTO`, `FACILITATOR_MERCHANT_ID` |
| quietpay-merchant-server | `QUIETPAY_API_KEY`, `QUIETPAY_WEBHOOK_SECRET`; optional refunds: `QUIETPAY_DASHBOARD_TOKEN`, `QUIETPAY_REFUND_SIGNER_PRIVATE_KEY`; plus `QUIETPAY_BASE_URL`, `QUIETPAY_MERCHANT_ID`, `QUIETPAY_PAYOUT_ADDRESS`, `QUIETPAY_WEBHOOK_URL` |
| quietpay-indexer-api | `MERCHANT_API_KEYS`, plus `FACILITATOR_PAYTO`, `FACILITATOR_MERCHANT_ID` (set both or neither) |

   `QUIETPAY_WEBHOOK_SECRET` is the merchant's derived secret, `lowercase hex HMAC-SHA256(key=WEBHOOK_SECRET, message=merchantId lowercase)`; derive it with `printf %s 0x<merchantId lowercase> | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET"` on your machine, not in a shared log.
4. URLs: after the first deploy, put the relayer URL into `FACILITATOR_URL` (paid API) and `QUIETPAY_BASE_URL` (merchant server), the paid API URL into `PAID_API_PUBLIC_URL`, the merchant server URL plus `/webhooks/quietpay` into `QUIETPAY_WEBHOOK_URL`. Webhook and resource URLs must be public HTTPS (`ALLOW_PRIVATE_WEBHOOKS` stays `0`).
5. Fund the relayer address (shown by `/v1/health` as `relayer`) with testnet WBT for gas from the faucet. It needs no USDT.

Invariants (also in the blueprint): the relayer/facilitator is exactly ONE instance with ONE disk; a second process on the same database refuses to start (lock file `quietpay.db.lock`); `TRUST_PROXY_HOPS=1` behind Render's single proxy hop.

## 3. Smoke test

```
SMOKE_BASE_URL=https://<relayer>.onrender.com \
SMOKE_API_KEY=<a merchant api key> SMOKE_MERCHANT_ID=0x<its bytes32> \
SMOKE_CHAIN_ID=1874 SMOKE_ROUTER=0xb9D475cdd817900B45C356169c6FdC379B942d82 \
node deploy/smoke.mjs
```

Passes only when health shows chain 1874, the router, a relayer address and `paused:false`, an order is created with the key, a wrong key gets 401, and an oversize body gets 413. Other health URLs: paid API `/health`, merchant server `/health`, indexer `/v1/health`.

## 4. Backups and restore

Scheduled: `deploy/start.sh` runs an online backup (SQLite backup API, safe while the relayer writes) 60 s after start and then every `BACKUP_INTERVAL_SECONDS` (21600, six hours) into `/data/backups`, keeping the newest `BACKUP_KEEP` (14). Each file is integrity-checked, stamped with chain id and router, and has a `.sha256`. Render also snapshots the disk daily (platform feature).

On demand (Render shell on the relayer service, needs user):

```
cd /app/packages/relayer && ../../node_modules/.bin/tsx src/db-cli.ts backup
```

Restore (stop the relayer first, because restore takes the same lock and refuses while it runs; needs user):

1. Render dashboard: suspend `quietpay-relayer`; open a shell on it (or use a one-off job on the same disk).
2. `cd /app/packages/relayer && ../../node_modules/.bin/tsx src/db-cli.ts restore /data/backups/quietpay-<stamp>.db --force`
3. Resume the service, then run the smoke test.

Restore refuses: a different chain or router, a backup with no recorded identity, a changed file (checksum), a file that is not a database or lacks the relayer tables, an existing target without `--force`, and a running relayer. Orders, refunds, webhook deliveries and x402 rows are restored together.

Limit: backups on the same disk do not survive loss of that disk. Copy `/data/backups` off the platform on a schedule you choose (needs user), for example `scp`/`rsync` from a Render SSH session to storage you own.

## 5. Rollback

Render: Deploys, pick the last good deploy, Rollback. The database is untouched by a code rollback (migrations are additive). If a database restore is needed, section 4.

## 6. Not done and why

- No deployment (no credentials). No Docker image built (engine not running).
- Off-disk backup copy is yours to set up.
- Render `plan: starter` is a guess at the smallest paid tier with disks; adjust to your plan.
