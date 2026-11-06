# Quietpay x402 v2 facilitator

This package starts one combined relayer/facilitator process. Checkout, refunds and direct
agent transfers share the same ChainPort, NonceManager, sender lock, SQLite database,
rolling payer cap, gas reservation/loss budget and pause controls. Do not run the old
standalone relayer in parallel using the same wallet. The paid API is a separate server
and never receives the gas wallet key.

## Supported protocol profile

- x402 v2 HTTP, exact EVM, EIP-3009 TransferWithAuthorization, upfront payment flow.
- Whitechain Sepolia eip155:1874 and the specified six-decimal USDT token by default.
- EOA 65-byte signatures only. No Permit2, smart-wallet signatures, discovery or extensions.
- PAYMENT-REQUIRED, PAYMENT-SIGNATURE and PAYMENT-RESPONSE carry structured base64 JSON.
- Timestamp fields are decimal strings. validAfter must have passed; validBefore must be
  in the future and no more than maxTimeoutSeconds ahead. validAfter=0 is supported.

References checked during implementation:
[core v2](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md),
[HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md),
[exact EVM](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md).

## Start

Use Node 20 and the existing relayer environment (RPC, router, token, gas wallet, keys,
operator token, database and safety limits). Also set:

- PAID_API_PUBLIC_URL: actual public origin, e.g. http://localhost:8790 for local work.
- FACILITATOR_PAYTO: API owner's USDT receiving address; cannot be the router.
- FACILITATOR_MERCHANT_ID: registered merchant ID belonging to a configured API key.
- X402_QUOTE_AMOUNT=10000 and X402_SIGNAL_AMOUNT=20000: six-decimal token base units.
- X402_SETTLEMENT_WAIT_MS=5000: maximum response wait before returning a pending hash.

```powershell
pnpm --filter @quietpay/facilitator start
```

The process also serves all existing /v1/orders, /v1/relay/pay, refund, health, metrics and
pause routes. It uses PORT (default 8787) and the same persistent DATABASE_PATH. The new
Dockerfile must be built with the repository root as its context. Do not scale this wallet
to multiple replicas. Deployment is separate from this implementation.

## Facilitator API

GET /supported is public. POST /verify and /settle require a resource-server Bearer API key;
the buyer needs no API key. Bodies follow {x402Version:2, paymentPayload, paymentRequirements}.
The key must own the server-configured resource policy. This deployment supports the two
configured paid API URLs; clients cannot choose another resource, payTo, asset or price.

/verify validates without creating a receipt or broadcasting. It verifies the requirements,
resource, amount, recipient, time window, token-domain signature, payer balance, unused
nonce and simulation. It returns {isValid, invalidReason?, payer?}.

/settle inserts a unique (payer, nonce) receipt before sending. It quotes gas, checks the
shared limits and persists signed bytes, hash, nonce and gas reservation before broadcast.
Only a two-confirmation successful receipt containing exactly the expected token Transfer
makes the payment settled. Concurrent identical submissions cannot send twice. A receipt
timeout returns success=false/errorReason=settlement_pending and the nonempty transaction
hash. Retry the same payload; do not sign a fresh payment just because settlement is slow.

The authoritative x402_payments record stores resource, payer, payTo, amount, nonce,
transaction, status and delivery state. It is unique on payer/nonce and transaction hash.
Recovery reattaches to pending receipts, safely rebroadcasts saved bytes and uses bounded
same-nonce replacements under the same gas budget. An uncertain RPC response stays pending.
A failed transfer is retained as failed; its nonce is not automatically submitted again.

Operator /v1/metrics includes agentPayments counts, combined gas expenditure and rejected
settlement reasons. /v1/admin/pause and on-chain router pause block agent sends too.

## Delivery and retry policy

The SDK calls merchant-authenticated /v1/x402/delivery/claim, /complete, /release and /renew.
These are Quietpay application endpoints, not x402 protocol extensions. They issue exclusive,
expiring delivery leases only for confirmed settled receipts. The SDK renews a live lease,
marks a successful response delivered and releases it when execution/transport fails.
Only one failed-delivery retry is allowed (two attempts total). Once delivered, reusing
that authorization returns payment_replayed. Another merchant cannot claim a receipt.

A network failure can occur after a buyer receives data but before delivery acknowledgement
is stored. Bounded redelivery is recovery from that uncertainty, not a promise of exactly-once
network delivery. Keep handlers read-only or separately idempotent. A resource failure does
not refund the confirmed transfer automatically. Preserve the receipt and inspect its status.

Do not change resource prices or scope while receipts are awaiting delivery. EIP-3009 signs
recipient/amount/window/nonce, not the resource URL; the first accepted receipt binds the
resource in this database. Do not delete it or run a second facilitator for the same token
and wallet. A third party can broadcast a revealed EIP-3009 transfer; external settlement
outside this receipt path is not automatically granted data access. Production needs TLS.

## Paid API and ledger

See apps/paid-api/README.md for the two priced demo routes. The buyer pays the exact listed
USDT amount directly to the API owner; no router receipt or token relay fee is created for
that agent call. The operator absorbs WBT gas. Checkout still uses the router.

Configure the indexer's FACILITATOR_PAYTO and FACILITATOR_MERCHANT_ID to reconcile these
transfers as source=x402. The integration test proves both paths appear in a clean export
and pass the independent verifier. Transfers alone do not prove API data delivery.

## Validation limits

The tests use this repository's signer and actual Anvil contracts, including concurrent
checkout/agent sends, replay attempts, pending settlement, recovery and delivery retries.
Official x402 client interoperability on Whitechain has not been established. No live
settlement, hosted deployment or production custody is claimed.

### Current checks

37 Solidity tests and 211 workspace tests pass, including all three Anvil integrations.
Workspace typechecks and app/widget builds pass. The standalone facilitator suite has
16 tests and the paid API suite has 8. Docker images/hosting are prepared but have not
been built or deployed. No production contracts were changed for x402; the test token
was extended to model its direct-transfer authorization method.

The optional Render blueprint is `render.facilitator.yaml`; root `render.yaml`
retains main's tested relayer-only deployment.
