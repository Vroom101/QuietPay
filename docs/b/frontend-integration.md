# Frontend integration after merging main

Main is authoritative for PaymentRouter, the ABI, amount parsing, wallet checks,
payout pinning, fee-bound payment signatures, recovery and deployment records.
The previous branch-only handoff is superseded by this document.

## Checkout

POST /api/checkout to the merchant server with
`{"items":[{"id":"notebook","quantity":3}]}`.
For compatibility an item-to-quantity map is also accepted. Prices always come
from server/catalog.ts; a supplied cartTotal is ignored. Invalid carts return 400,
rate-limited callers return 429, and a mismatched relayer order returns 502.
Success returns `{orderId, amount, payout}`. amount is a decimal string with six
fractional digits. Pin that amount and payout on the widget, as main's checkout
page does; do not derive the expected payment from a second client price list.
GET /api/checkout/methods advertises direct USDT only. No conversion routes exist.

The widget reads GET /v1/orders/:id and submits POST /v1/relay/pay. Main's React
wrapper accepts expectedAmount (decimal token units), expectedPayout and the
trusted deployment overrides chainId/token/router/domainName/domainVersion.
Default deployment values come from shared deployment records. Conversion is
outside this merge. The payer wallet remains a test-only browser wallet.

## Orders and refunds

Order amount, fee and refunded are six-decimal token base-unit integer strings.
refundedAmount remains available for main's consumers and equals refunded.
refundCount counts settled refunds. Statuses include main's created/pending/
settled/failed/expired plus partially_refunded/refunded. A refunded payment is
still a completed payment; it is never offered for payment again.

The deployed router receipt ABI is main's: refundCount (uint32), then
 totalRefunded (uint256). Do not replace it with the older branch tuple. The
relayer adapter maps those named fields to its refund context representation.
Payment nonces use quietpay.pay.v2 and MUST include the relay fee. Refund nonces
remain quietpay.refund.v1. buildRefundAuthorization supports main's supplied
nonce form as well as the branch's merchantId/orderId/payer/refundIndex form.

Dashboard calls go through /api/merchant using a separate dashboard token.
The merchant server holds the relayer API key and refund signer private key.
See dashboard-refunds.md for review, submission and status routes.
Relayer endpoints remain GET /v1/orders, GET /v1/orders/:id/refund-context,
GET /v1/orders/:id/refunds, POST /v1/relay/refund, GET /v1/refunds/:id.
Refund events require refundId/refundAmount/totalRefunded/refundIndex.

## Persistence and configuration

The merchant entry point enables SQLite receipts at QUIETPAY_RECEIPT_DATABASE_PATH
(default quietpay-receipts.db). Signed settlement events are rechecked with the
relayer before recording. Duplicate event IDs and verified receipts survive restart.
Main's JSON stateFile path remains supported. Existing JSON state should be kept
when enabling SQLite; the server reads both. Back up SQLite with its WAL files.

Webhook verification uses the per-merchant derived secret from main's relayer,
not the relayer's master WEBHOOK_SECRET. Configure QUIETPAY_WEBHOOK_SECRET with
that derived value. Public endpoints retain main's rate limits and SSRF checks.

Relayer deployment: CHAIN_ID/USDT_ADDRESS/ROUTER_ADDRESS/TOKEN_DOMAIN_NAME/
TOKEN_DOMAIN_VERSION. Merchant refunds pin QUIETPAY_CHAIN_ID/QUIETPAY_TOKEN_ADDRESS/
QUIETPAY_ROUTER_ADDRESS and the same token domain. SDK callers can pin chainId,
tokenAddress and tokenDomain. Run the read-only preflight for the selected deployment.
Main's qualifying router and live payment/refund evidence are retained unchanged.
Do not reuse signed authorizations or created orders from the older fee-free
nonce protocol; create fresh orders against the deployed v2 router. Archive and
reconcile any legacy development database with outstanding transactions before
switching it to this service; never replay it against a different deployment.

## Indexer interfaces

Main's indexer CLI and independent @quietpay/verifier remain authoritative.
The branch's merchant-scoped ledger HTTP service is preserved under
@quietpay/indexer/api (implementation src/api, tests test/api). Start it with
pnpm --filter @quietpay/indexer start; its CLI is api:cli. Its HTTP export format
and verification result are separate from main's independent verifier format.
Do not interchange the two CSV/metadata formats or verifier entry points.

## Local validation

Use Node 20 for the installed SQLite binary. Workspace TypeScript checks pass.
All workspace suites were exercised; fixes were followed by targeted reruns.
Anvil and Foundry were unavailable, so fresh Solidity/Anvil runs and the optional
live-RPC sample test still require CI or an environment with those tools.
