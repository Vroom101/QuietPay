# Frontend integration contract

The backend branch owns the shared schemas, refund signing helper and router ABI.
Use packages/shared/src/schemas.ts and packages/shared/src/abi/PaymentRouter.ts.
Keep the current receipt tuple: payer, payout, value, fee, paidAt, settled,
refunded (uint256), refundCount (uint256). No contract migration is needed.

## Checkout

POST /api/checkout to the merchant server with
`{"items":{"notebook":3},"cartTotal":"25.50"}`.
The server recomputes catalog prices, rejects malformed carts with 400 and
price mismatches with 409, and returns `{"orderId":"0x..."}`.
Client-only cartTotal requests are no longer accepted. The current old checkout
UI must be updated by the frontend teammate to send quantities.
GET /api/checkout/methods returns only the direct USDT route, with id usdt and
simulated false. Conversion endpoints are not enabled or implemented here.

The widget reads GET /v1/orders/:id and submits POST /v1/relay/pay to the
relayer. GET /api/orders/:id/paid on the merchant server confirms the signed
webhook receipt, independently of the browser's settlement callback.
Verified receipts and webhook deduplication persist atomically in SQLite.
The server entry point uses QUIETPAY_RECEIPT_DATABASE_PATH (quietpay-receipts.db
by default). Tests may use :memory:. Keep a persistent hosting volume and back up
SQLite together with its WAL files. Databases are scoped to merchant and relayer.
Foreign-merchant webhooks are rejected; payment.refunded does not erase the
original payment receipt.

## Orders and refunds

Order amount, fee and refunded are decimal strings in six-decimal token base units.
refunded is the cumulative settled refund amount; refundCount counts settled refunds.
Statuses: created, pending, settled, failed, expired, partially_refunded, refunded.
For a 25 USDT order, a partial refund response includes
`{"amount":"25000000","status":"partially_refunded","refunded":"5000000","refundCount":1}`;
a full refund includes
`{"amount":"25000000","status":"refunded","refunded":"25000000","refundCount":2}`.
These are response excerpts; the shared Order schema defines all required fields.
Do not use refundedAmount or treat refunded orders as unpaid.

The dashboard uses the merchant server's existing authenticated routes under
/api/merchant (see dashboard-refunds.md), with a separate dashboard token.
Keep the merchant API key and refund signer private key server-side.
Low-level merchant-authenticated relayer endpoints remain:
GET /v1/orders; GET /v1/orders/:id/refund-context;
GET /v1/orders/:id/refunds; POST /v1/relay/refund; GET /v1/refunds/:id.
Preserve buildRefundAuthorization's merchantId/orderId/payer/amount/refundIndex
inputs: it computes the nonce internally.

## Trusted deployment configuration

Relayer: CHAIN_ID, USDT_ADDRESS, ROUTER_ADDRESS, TOKEN_DOMAIN_NAME,
TOKEN_DOMAIN_VERSION. Domain defaults remain Tether USD / 1.
Merchant refunds: QUIETPAY_CHAIN_ID, QUIETPAY_TOKEN_ADDRESS,
QUIETPAY_ROUTER_ADDRESS, TOKEN_DOMAIN_NAME, TOKEN_DOMAIN_VERSION.
SDK refund callers can pin tokenAddress, chainId and tokenDomain explicitly.
Frontend: VITE_RELAYER_URL, VITE_CHECKOUT_ROUTER; for a custom token set all of
VITE_CHECKOUT_TOKEN, VITE_CHECKOUT_DOMAIN_NAME, VITE_CHECKOUT_DOMAIN_VERSION.
All values must describe the same deployment. Do not infer mock operation from
port 8787. The shared router address is still null until deployment is verified.
No chain deployment or secret configuration is performed by this source update.

Run the existing read-only relayer preflight against the selected environment,
then verify checkout, signed webhook, partial/full refund and merchant restart.
The regression tests exercise domain signing and durable receipts locally;
mock browser tests alone do not prove on-chain settlement.

## Validation of this update

Run tests with Node 20: the installed better-sqlite3 binary targets Node 20
and cannot load in the machine's default Node 24 runtime.
Local suites passed: demo-store (21), merchant SDK (21), facilitator (15),
and relayer (81 total, including the new domain preflight regression).
The relayer and facilitator Anvil tests require their explicit environment
configuration and were skipped; live deployment verification is still required.
