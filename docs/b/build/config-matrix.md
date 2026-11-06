# Config matrix: QuietPay backend services

Read-only survey of branch `backend/remaining-build` (worktree `C:\Users\avane\Desktop\QuietPay-build`). Names, defaults and URL targets only. No secret value appears in this file.

Sources: `packages/relayer/src/config.ts`, `index.ts`, `server.ts`; `packages/facilitator/src/config.ts`, `main.ts`, `server.ts`; `apps/paid-api/src/main.ts`, `app.ts`; `apps/demo-store/server/index.ts`, `scripts/simulate-webhook.ts`; `packages/indexer/src/api/config.ts`, `main.ts`, `server.ts`; `packages/indexer/src/cli.ts` (CLI-only names, see Mismatches); `packages/agent-client/src`; `apps/agent-demo/src/main.ts`; `.env.example`; `render.yaml`; `render.facilitator.yaml`.

Service URL targets: "relayer/facilitator" means the service in this table with the same name.

## 1. Relayer (`packages/relayer`, entry `src/index.ts`, Dockerfile in `render.yaml`)

The relayer reads these variables through `loadConfig` in `src/config.ts`. Dockerfile sets `PORT=8787` and `DATABASE_PATH=/data/quietpay.db`.

| Variable | Required or default | What it is | Secret | Points to |
|---|---|---|---|---|
| RPC_URL | required (URL) | Whitechain JSON-RPC endpoint | no | external chain RPC |
| CHAIN_ID | default 1874 | Chain id; startup checks the node reports the same id | no | none |
| USDT_ADDRESS | required (0x address) | Payment token; must equal the qualifying token | no | none |
| ROUTER_ADDRESS | required (0x address) | PaymentRouter; must equal the qualifying router | no | none |
| RELAYER_PRIVATE_KEY | required (0x 64 hex) | Key that signs and broadcasts relayer transactions | yes | none |
| OPERATOR_TOKEN | required, min 16 chars | Bearer token for operator-only routes | yes | none |
| MERCHANT_API_KEYS | required; `apiKey:0x<bytes32>` pairs | Merchant API keys mapped to merchant ids; each key min 24 chars | yes | none |
| WEBHOOK_SECRET | required, min 16 chars | Master key; per-merchant webhook secrets are derived from it | yes | merchant webhook URLs (signs deliveries) |
| ALLOW_PRIVATE_WEBHOOKS | default 0 | 1 allows loopback and private webhook URLs (local dev only) | no | merchant webhook URLs |
| DATABASE_PATH | default ./quietpay.db | SQLite file path (persistent) | no | none |
| LOSS_BUDGET_WBT_PER_HOUR | default 0.05 | Hard cap on gas lost to reverts per rolling hour | no | none |
| MAX_GAS_PRICE | optional (wei); empty = no cap | Gas price ceiling | no | none |
| PAYER_CAP_USDT | default 100 | Cumulative per-payer cap, rolling 24 h | no | none |
| MAX_GAS_LIMIT | default 500000 | Gas limit per relayed transaction | no | none |
| LOW_BALANCE_WBT | default 0.01 | Low relayer balance threshold | no | none |
| PENDING_RETRY_SECONDS | default 30, min 5 | Retry interval for pending transactions | no | none |
| MAX_REPLACEMENTS | default 3, range 0-10 | Replacement transactions allowed per order | no | none |
| SETTLE_CONFIRMATIONS | default 1, range 1-64 | Blocks a success receipt must be buried under before settle | no | none |
| RELAY_FEE_USDT | default 0.05 | Relay fee, USDT | no | none |
| RATE_LIMIT_PER_MINUTE | default 20 | Per-client request limit per minute | no | none |
| EXPLORER_BASE_URL | default https://testnet.whitechain.io | Explorer base for transaction links | no | external explorer |
| TOKEN_DOMAIN_NAME | default "Tether USD" | EIP-712 domain name of the token | no | none |
| TOKEN_DOMAIN_VERSION | default 1 | EIP-712 domain version of the token | no | none |
| PORT | default 8787 | HTTP listen port | no | none |
| MIN_VALID_SECONDS | default 60 | Authorization must have this many seconds left at broadcast | no | none |
| REVERTED_PAYER_MIN_VALID_SECONDS | default 120 | Same, for a payer with a revert in the last 24 h | no | none |
| MAX_REVERTS_PER_DAY | default 2 | Refuse payer or order after this many reverts in 24 h | no | none |
| PAYER_LOSS_SHARE_PERCENT | default 25, range 1-100 | Share of loss budget one payer's reverts may use per hour | no | none |
| TX_MAX_AGE_SECONDS | default 1800, min 600 | Age limit for a broadcast transaction with no receipt | no | none |
| FIRST_TIME_PAYER_LOSS_SHARE_PERCENT | default 5, range 0-100 | Share of loss budget first-time payer reverts may use | no | none |
| FIRST_TIME_PAYER_LOSS_CAP_PERCENT | default 100, range 0-1000 | Ceiling on first-time payer revert loss per hour | no | none |
| MAX_NEW_PAYERS_PER_IP_PER_HOUR | default 10 | First-time payer addresses one client IP may use per hour | no | none |
| TRUST_PROXY_HOPS | default 0, range 0-10 | Trusted reverse proxies in front (Render = 1) | no | none |
| RECONCILE_INTERVAL_SECONDS | default 30 | Reconciliation loop interval | no | none |

## 2. Facilitator (`packages/facilitator`, Dockerfile in `render.facilitator.yaml`)

`src/config.ts` calls the relayer `loadConfig`, so every relayer variable above also applies. Entry `src/main.ts` runs the relayer and facilitator routes in one process on the relayer PORT. Additional variables:

| Variable | Required or default | What it is | Secret | Points to |
|---|---|---|---|---|
| PAID_API_PUBLIC_URL | required (URL) | Public base URL of the paid API, used to build resource URLs | no | paid API |
| FACILITATOR_PAYTO | required (0x address) | Payee address for x402 payments | no | none (on-chain payee) |
| FACILITATOR_MERCHANT_ID | required (0x bytes32) | Merchant id of the facilitator's own resource server | no | none |
| X402_SETTLEMENT_WAIT_MS | default 5000, range 0-60000 | Wait for settlement before answering | no | none |
| X402_QUOTE_AMOUNT | default "10000" | Quote price, base units | no | none |
| X402_SIGNAL_AMOUNT | default "20000" | Signal price, base units | no | none |

## 3. Paid API (`apps/paid-api/src/main.ts`, `app.ts`)

| Variable | Required or default | What it is | Secret | Points to |
|---|---|---|---|---|
| PAID_API_PUBLIC_URL | required (URL) | Public base URL of this API | no | itself (resource URLs) |
| FACILITATOR_URL | required (URL) | Facilitator endpoint used to verify and settle | no | relayer/facilitator |
| QUIETPAY_API_KEY | required, min 1 | Merchant API key sent to the facilitator | yes | sent to relayer/facilitator |
| FACILITATOR_MERCHANT_ID | required (0x bytes32) | Merchant id for the paywall policies | no | none |
| FACILITATOR_PAYTO | required (0x address) | Payee address in the policies | no | none |
| CHAIN_ID | default 1874 | Chain id | no | none |
| USDT_ADDRESS | default: official test token | Payment token address | no | none |
| PAID_API_PORT | default 8790 | HTTP listen port | no | none |
| X402_QUOTE_AMOUNT | default "10000" | Quote price, base units | no | none |
| X402_SIGNAL_AMOUNT | default "20000" | Signal price, base units | no | none |

## 4. Merchant server, demo store (`apps/demo-store/server/index.ts`)

Listens on 127.0.0.1 only. Exits at startup if QUIETPAY_API_KEY or QUIETPAY_WEBHOOK_SECRET is missing.

| Variable | Required or default | What it is | Secret | Points to |
|---|---|---|---|---|
| QUIETPAY_API_KEY | required | Merchant API key for relayer calls | yes | relayer/facilitator |
| QUIETPAY_WEBHOOK_SECRET | required | Merchant-derived webhook secret (verifies deliveries) | yes | none |
| QUIETPAY_BASE_URL | default http://localhost:8787 | Relayer/facilitator base URL | no | relayer/facilitator |
| QUIETPAY_MERCHANT_ID | default merchantIdFromSlug("demo-store") | Merchant id | no | none |
| QUIETPAY_PAYOUT_ADDRESS | optional (0x address) | Store payout address; unset means the relayer's payout is trusted | no | none |
| QUIETPAY_WEBHOOK_URL | optional | Public URL the relayer posts webhooks to (store route `/webhooks/quietpay`) | no | store's own webhook route |
| QUIETPAY_STATE_FILE | default .data/demo-store-state.json | Paid orders and processed webhook ids (persistent) | no | none |
| QUIETPAY_RECEIPT_DATABASE_PATH | default quietpay-receipts.db | Receipt database (persistent) | no | none |
| QUIETPAY_DASHBOARD_TOKEN | optional | Enables the refunds block when set | yes | none |
| QUIETPAY_ROUTER_ADDRESS | required when dashboard token set | Router for refunds | no | none |
| QUIETPAY_CHAIN_ID | default 1874 | Chain id for refunds | no | none |
| QUIETPAY_TOKEN_ADDRESS | optional | Token address for refunds | no | none |
| TOKEN_DOMAIN_NAME | default "Tether USD" | EIP-712 domain name (refunds) | no | none |
| TOKEN_DOMAIN_VERSION | default 1 | EIP-712 domain version (refunds) | no | none |
| QUIETPAY_REFUND_SIGNER_PRIVATE_KEY | required when dashboard token set | Key that signs refunds | yes | none |
| QUIETPAY_MERCHANT_DATABASE_PATH | default quietpay-merchant.db | Refund merchant database (persistent) | no | none |
| PORT | default 3001 | Listen port | no | none |

`scripts/simulate-webhook.ts` also reads QUIETPAY_WEBHOOK_SECRET, QUIETPAY_MERCHANT_ID and PORT.

## 5. Indexer merchant-ledger API (`packages/indexer/src/api/config.ts`, `main.ts`, `server.ts`)

`main.ts` refuses to start when MERCHANT_API_KEYS is empty.

| Variable | Required or default | What it is | Secret | Points to |
|---|---|---|---|---|
| RPC_URL | required (URL) | Chain RPC used to read logs | no | external chain RPC |
| CHAIN_ID | default 1874 | Chain id; must match the node | no | none |
| ROUTER_ADDRESS | required (0x address) | PaymentRouter address | no | none |
| USDT_ADDRESS | required (0x address) | Token address | no | none |
| INDEXER_FROM_BLOCK | required (integer >= 0) | First block to index (deployment block) | no | none |
| INDEXER_CONFIRMATIONS | default 2, range 1-10000 | Confirmations before a block is final | no | none |
| INDEXER_DATABASE_PATH | default ./quietpay-indexer.db | Indexer SQLite file (persistent) | no | none |
| INDEXER_POLL_MS | default 5000, min 100 | Poll interval | no | none |
| INDEXER_PORT | default 8788 | HTTP listen port | no | none |
| MERCHANT_API_KEYS | required in main.ts; `apiKey:0x<bytes32>` pairs | Merchant API keys for ledger routes | yes | none |
| FACILITATOR_PAYTO | optional; set with FACILITATOR_MERCHANT_ID or neither | Facilitator payee for the agent scope | no | none |
| FACILITATOR_MERCHANT_ID | optional; set with FACILITATOR_PAYTO or neither | Facilitator merchant id | no | none |

## 6. Agent client (`packages/agent-client/src`)

Library only. `src` contains `index.ts` and reads no environment variables. Configuration is passed to `createAgent` in code (signer, chainId, asset, domain, allowed origins and payees, per-call limit, session budget, explorer URL). It has no port, health path, persistent path or public URL.

## 7. Agent demo (`apps/agent-demo/src/main.ts`)

A one-shot script, not a server. The demo payer must hold zero native currency.

| Variable | Required or default | What it is | Secret | Points to |
|---|---|---|---|---|
| AGENT_PRIVATE_KEY | required (0x 64 hex) | Demo payer key | yes | none |
| PAID_API_PUBLIC_URL | required (URL) | Paid API the agent calls | no | paid API |
| FACILITATOR_PAYTO | required (0x address) | Only payee the agent accepts | no | none |
| RPC_URL | required (URL) | Chain RPC for balance and receipt checks | no | external chain RPC |
| AGENT_PER_CALL_LIMIT | default 20000 | Max amount per call, base units | no | none |
| AGENT_SESSION_BUDGET | default 30000 | Max total authorized in the session, base units | no | none |
| AGENT_EXPLORER_URL | required (URL) | Explorer base for printed receipts | no | external explorer |

## Summary per service

Relayer

| Port variable (default) | Health path | Persistent path variable | Public URL variable |
|---|---|---|---|
| PORT (8787) | /v1/health | DATABASE_PATH | none read by the relayer |

Facilitator (same process model as relayer; `render.facilitator.yaml`)

| Port variable (default) | Health path | Persistent path variable | Public URL variable |
|---|---|---|---|
| PORT (8787) | /v1/health | DATABASE_PATH | PAID_API_PUBLIC_URL (paid API) |

Paid API

| Port variable (default) | Health path | Persistent path variable | Public URL variable |
|---|---|---|---|
| PAID_API_PORT (8790) | /health | none | PAID_API_PUBLIC_URL |

Merchant server (demo store)

| Port variable (default) | Health path | Persistent path variable | Public URL variable |
|---|---|---|---|
| PORT (3001) | none defined | QUIETPAY_STATE_FILE, QUIETPAY_RECEIPT_DATABASE_PATH, QUIETPAY_MERCHANT_DATABASE_PATH | QUIETPAY_WEBHOOK_URL |

Indexer merchant-ledger API

| Port variable (default) | Health path | Persistent path variable | Public URL variable |
|---|---|---|---|
| INDEXER_PORT (8788) | /v1/health | INDEXER_DATABASE_PATH | none |

Agent client

| Port variable (default) | Health path | Persistent path variable | Public URL variable |
|---|---|---|---|
| none | none | none | none |

Agent demo

| Port variable (default) | Health path | Persistent path variable | Public URL variable |
|---|---|---|---|
| none | none | none | PAID_API_PUBLIC_URL (target, not served) |

## Mismatches

Rule: a name is listed if code reads it and it is absent from `.env.example`, or absent from the blueprint that deploys that code. Relayer code is checked against `render.yaml` and `render.facilitator.yaml`; facilitator and paid API code against `render.facilitator.yaml`. The indexer and demo store have no blueprint, so their names are reported as absent from both. The agent demo has no blueprint and all of its names are in `.env.example`, so it is not counted. "yes" means present, "no" means absent.

| # | Names | .env.example | render.yaml | render.facilitator.yaml | Used by |
|---|---|---|---|---|---|
| 1 | ALLOW_PRIVATE_WEBHOOKS | yes | no | no | relayer, facilitator |
| 2 | SETTLE_CONFIRMATIONS | no | no | no | relayer, facilitator |
| 3 | RELAY_FEE_USDT | no | no | no | relayer, facilitator |
| 4 | RATE_LIMIT_PER_MINUTE | no | no | no | relayer, facilitator |
| 5 | EXPLORER_BASE_URL | no | yes | yes | relayer, facilitator |
| 6 | TOKEN_DOMAIN_NAME | yes | no | no | relayer, facilitator |
| 7 | TOKEN_DOMAIN_VERSION | yes | no | no | relayer, facilitator |
| 8 | PORT | no | no | no | relayer, facilitator, demo store |
| 9 | MIN_VALID_SECONDS | no | no | no | relayer, facilitator |
| 10 | REVERTED_PAYER_MIN_VALID_SECONDS | no | no | no | relayer, facilitator |
| 11 | MAX_REVERTS_PER_DAY | no | no | no | relayer, facilitator |
| 12 | PAYER_LOSS_SHARE_PERCENT | no | no | no | relayer, facilitator |
| 13 | TX_MAX_AGE_SECONDS | no | no | no | relayer, facilitator |
| 14 | FIRST_TIME_PAYER_LOSS_SHARE_PERCENT | no | no | no | relayer, facilitator |
| 15 | FIRST_TIME_PAYER_LOSS_CAP_PERCENT | no | no | no | relayer, facilitator |
| 16 | MAX_NEW_PAYERS_PER_IP_PER_HOUR | no | no | no | relayer, facilitator |
| 17 | RECONCILE_INTERVAL_SECONDS | no | no | no | relayer, facilitator |
| 18 | MAX_GAS_LIMIT | yes | no | yes | relayer, facilitator |
| 19 | LOW_BALANCE_WBT | yes | no | yes | relayer, facilitator |
| 20 | PENDING_RETRY_SECONDS | yes | no | yes | relayer, facilitator |
| 21 | MAX_REPLACEMENTS | yes | no | yes | relayer, facilitator |
| 22 | FACILITATOR_MERCHANT_ID | no | not used by relayer | yes | facilitator, paid API, indexer API |
| 23 | INDEXER_FROM_BLOCK, INDEXER_CONFIRMATIONS, INDEXER_DATABASE_PATH, INDEXER_POLL_MS, INDEXER_PORT | yes | no blueprint | no blueprint | indexer API |
| 24 | QUIETPAY_WEBHOOK_SECRET, QUIETPAY_PAYOUT_ADDRESS, QUIETPAY_BASE_URL, QUIETPAY_MERCHANT_ID, QUIETPAY_WEBHOOK_URL, QUIETPAY_STATE_FILE, QUIETPAY_RECEIPT_DATABASE_PATH, QUIETPAY_DASHBOARD_TOKEN, QUIETPAY_ROUTER_ADDRESS, QUIETPAY_CHAIN_ID, QUIETPAY_TOKEN_ADDRESS, QUIETPAY_REFUND_SIGNER_PRIVATE_KEY, QUIETPAY_MERCHANT_DATABASE_PATH | no | no blueprint | no blueprint | demo store |
| 25 | DEPLOY_BLOCK, POLL_SECONDS, GENERATED_AT | no | not applicable | not applicable | indexer CLI (`src/cli.ts`) |
| 26 | CONFIRMATIONS (reverse) | yes | not applicable | not applicable | listed in .env.example; read only by indexer CLI, not the ledger API (which reads INDEXER_CONFIRMATIONS) |
| 27 | DEPLOYER_PRIVATE_KEY (reverse) | yes | not applicable | not applicable | listed in .env.example; no code in the repo reads it |

Totals: 27 mismatch rows covering 45 names (rows 1-22 cover 22 names; rows 23-24 cover 18 names; row 25 covers 3 names; rows 26-27 cover 2 names).

Notes, not counted as mismatches:

- `render.yaml` and `render.facilitator.yaml` both define a web service named `quietpay-relayer` with different Dockerfiles. Only one can be deployed under that name.
- The indexer API reads `INDEXER_DATABASE_PATH`, while the indexer CLI reads `DATABASE_PATH`. Both names are in `.env.example`.
- The agent demo names are all in `.env.example`. No blueprint deploys the agent demo.

## Deployment invariants

- One instance and one process per relayer key (SQLite, one file).
- Persistent disk required for the database path.
- Webhook and resource URLs must be public HTTPS.
