# Status

## CP0 (shared specs): done, tag `shared-v1`
- Token facts read from the live USDT; primary path is `receiveWithAuthorization`. Live gasless tx still pending a funded key.

## CP1 (router and first payment): partial
- Router built, 37 Foundry tests pass. Not deployed or verified; no real payment yet (needs funded keys).

## CP2 (full checkout): code complete locally, tag `cp2-local`
- Widget, relayer, SDK, store and dashboard merged; TS tests include an anvil end-to-end run with a zero-balance payer.
- Not yet run: live chain, hosted relayer, browser walkthrough.

## Partial refunds: code complete locally
- Router supports sequential, payer-bound partial/full refunds from the merchant refundSigner.
- Merchant-authenticated context, relay and status endpoints, SDK signing, durable recovery and signed refund webhooks implemented.
- Anvil integration proves payment, partial refund and remaining refund through the SDK, with payer and refundSigner both holding zero native currency.
- New ABI is generated from the Solidity build. Live deployment remains pending. Dashboard controls and merchant-server signing routes are now implemented locally (see below).

## Ledger/export/verifier: implemented locally
- Read-only packages/indexer polls confirmed router/merchant events in pages of at most 1,000 blocks, persists progress and repairs reorgs.
- Merchant-scoped ledger APIs, event CSV plus metadata, and independent RPC verification are available through HTTP and CLI.
- Optional direct-transfer accounting is supported for an explicitly configured payTo/merchant pair; this is not an x402 facilitator implementation.
- The verifier reports altered, missing, extra and duplicate rows and a repeatable chain checkpoint; pre-range history supports refund-only exports.
- Live exports, hosting and a verifier/dashboard UI remain pending deployment.

## x402 facilitator and paid API: implemented locally
- x402 v2 exact EIP-3009/upfront schemas, verification, direct settlement and structured HTTP headers are implemented.
- One combined relayer/facilitator shares the wallet nonce manager, persisted gas budget, sender lock and pause controls.
- SDK paywall middleware guards two demo API resources and uses exclusive delivery leases with at most one failed-delivery retry.
- Anvil integration proves paid HTTP requests, duplicate rejection, concurrent checkout/agent wallet nonces and verified ledger export.
- Official-client interoperability, hosted services and live testnet settlement remain pending. The scripted agent client/demo is implemented below; a browser agent UI is not included.

## Agent client and scripted demo: implemented locally
- `packages/agent-client` negotiates x402 challenges, pins network/token/domain/recipient/origin, reserves a per-call/session budget before signing and records public settlement receipts.
- Pending/unknown payments reuse the same authorization with `retry(id)`; concurrent requests cannot exceed the session budget or sign twice for an unresolved resource.
- `apps/agent-demo` buys a quote and signal, prints receipt/explorer links and checks successful RPC receipts plus zero payer native balance.
- Sessions and pending authorizations are in memory; crash recovery and durable shared agent budgets are not implemented. Live testnet proof and a browser demo UI remain pending.

## Dashboard refunds and merchant integration: implemented locally
- Dashboard shows precise remaining/refunded amounts, signer balance, partial/full refund review, pending/settled/failed history and reload-safe business request IDs.
- Demo-store merchant server exposes separately authenticated order/refund routes and holds both the relayer API key and refundSigner key server-side.
- A scoped SQLite journal deduplicates retries/concurrent requests and reconciles uncertain SDK responses after restart without automatic re-signing.
- Real HTTP Anvil checkout integration now proves insufficient-balance rejection plus partial/full refunds through the merchant server. Live deployment/hosted browser walkthrough and customer-facing refund tracking remain pending.
