# Dashboard refunds and merchant-server routes

The dashboard requests refunds from the demo-store merchant server. The merchant server alone holds the relayer API key and merchant refundSigner key. The browser receives the public balance/context, refund history and operation status. A separate dashboard access token authorizes order reads and refunds for the configured merchant; treat it as permission to spend the refund wallet's test USDT.

## Setup

1. Use Node 20 and install workspace dependencies. Deploy the current router, register the merchant/refundSigner and allowlist the relayer; start the real relayer or combined facilitator. Refunds do not work against the fixture mock.
2. Copy `apps/demo-store/.env.example` to `apps/demo-store/.env`. Fill the existing `QUIETPAY_BASE_URL`, `QUIETPAY_API_KEY`, `QUIETPAY_MERCHANT_ID` and webhook secret. Add:

| Setting | Purpose |
| --- | --- |
| `QUIETPAY_DASHBOARD_TOKEN` | Separate high-entropy access token, at least 32 characters; generate locally, e.g. with `openssl rand -hex 32` |
| `QUIETPAY_ROUTER_ADDRESS` | Pinned deployed router address |
| `QUIETPAY_REFUND_SIGNER_PRIVATE_KEY` | Merchant's server-only refund wallet key |
| `QUIETPAY_MERCHANT_DATABASE_PATH` | Persistent SQLite path, default `quietpay-merchant.db`; separate from the relayer DB |

3. Fund the registered refundSigner with test USDT. The original payout stays in the payout wallet. Refunds return the full selected amount to the original payer; the operator sponsors gas.
4. Start the merchant server with the environment file, then start the dashboard:

```sh
pnpm --filter @quietpay/demo-store exec node --env-file=.env --import tsx server/index.ts
pnpm --filter @quietpay/merchant-dashboard dev
```

5. Open the dashboard on port 5174 and enter `QUIETPAY_DASHBOARD_TOKEN`. Its default `/api/merchant` URL is proxied to the merchant server on port 3001. Do not enter the relayer API key. Production must route `/api/merchant/*` through the dashboard's same-origin HTTPS proxy to this merchant server; the server deliberately adds no permissive CORS headers. No server secret belongs in `VITE_*` variables.
6. Select a settled/partially refunded order, enter an amount (up to six decimal places) or choose the remaining amount, review, then confirm. The panel refreshes every three seconds. A fully refunded order offers history only. Fixture mode keeps refund buttons disabled.

## HTTP routes

All require `Authorization: Bearer <dashboard token>` and return `Cache-Control: no-store`.

- `GET /api/merchant/orders`: merchant-scoped order list through SDK `listOrders()`.
- `GET /api/merchant/orders/:id/refund-context`: pinned context including the current refund wallet balance, relayer refund history and merchant request journal entries.
- `POST /api/merchant/orders/:id/refunds`: `{requestId: <UUID>, amount: <positive base-unit string>, refundIndex: <expected index>}`. Amount `5000000` means 5 USDT. For a full refund send `amountPaid - refunded` explicitly. Only these three fields are accepted: callers cannot select the payer, merchant, signer, router, network or signing domain.

The server checks the merchant/deployment/token/domain/signer, expected refund index, remaining amount, signer balance and existing pending/uncertain requests before invoking SDK `refund()`. The SDK repeats its checks before signing. The signer key and authorization signature are never returned to the browser. The access token is stored in sessionStorage; the browser stores only the request UUID, amount and expected index in localStorage for reload recovery. This demo uses a bearer token, not a multi-user identity/role system.

## Retry and recovery

SQLite commits the business identity before calling the signer (`synchronous=FULL`, WAL). There is at most one unresolved request per order. An exact repeat of the same request ID returns/reconciles that request without another SDK refund invocation; changing its amount, order or index returns 409. Concurrent requests also share a unique database constraint.

A normal submission returns 202 with a pending refund. The panel tracks settlement and failure through the context route. Explicit pre-send/relayer rejections appear as failures with a reason; a new request requires a deliberate action after reviewing fresh state.

A timeout, malformed response or server-side error after invoking the SDK becomes `unknown`; it never invites a fresh signature. Use **Check original request** or refresh status. The server finds a newly recorded relayer refund by its expected index/amount, excluding IDs already present before signing, and retains its status. The request journal survives merchant-server restarts and is bound to merchant/router/token/chain/refundSigner scope.

A crash after journaling but before the SDK call can leave a request unresolved with no relayer row. The server intentionally does not automatically re-sign it. An operator must reconcile the relayer and chain before manually resolving that journal entry; no automatic reset API is provided. Keep the journal and relayer history available and do not delete the DB to retry an uncertain payment. Run one merchant-server instance for this demo, use a persistent local disk and back it up with SQLite-aware tooling. This is bounded recovery, not exactly-once network delivery.

Implemented/tested locally on Anvil. Live testnet deployment and a hosted browser walkthrough remain pending. Customer-facing refund webhooks/status (feature 3), dashboard ledger export and the verifier UI remain separate work.
