# Quietpay paid API

Two static, explicitly labeled demo resources demonstrate settlement-gated delivery:
GET /v1/quote costs 0.01 USDT and GET /v1/signal costs 0.02 USDT by default. Their contents
are demo data, not live market information. GET /health is free.

Set PAID_API_PUBLIC_URL, FACILITATOR_URL, FACILITATOR_PAYTO, FACILITATOR_MERCHANT_ID,
QUIETPAY_API_KEY (the API server's merchant key), USDT_ADDRESS and CHAIN_ID. Use the same
resource origin, prices and payTo in the combined facilitator. PAID_API_PORT defaults to 8790. No gas wallet or payer private key belongs in this process.

```powershell
pnpm --filter @quietpay/paid-api start
```

An unpaid request returns 402 with PAYMENT-REQUIRED (base64 structured v2 JSON) and the
same challenge in the JSON body. Sign the token TransferWithAuthorization with a new
random bytes32 nonce, the advertised payTo/value/network/domain, validAfter=0 and a
validBefore within the advertised timeout. Retry the same URL using PAYMENT-SIGNATURE
with {x402Version:2,resource,accepted,payload:{signature,authorization}}.

Malformed or wrong-resource payment headers return 400 without executing the resource.
The resource executes only after confirmed settlement and an exclusive delivery claim.
Success includes PAYMENT-RESPONSE with transaction/network/payer. A pending transfer
returns a retryable 402 with its existing hash and no protected data. Retry that payload,
not a new payment. An unknown facilitator result returns 503 without inviting a fresh
payment. Failed resource execution allows at most one redelivery using the same proof.
Keep handlers idempotent and do not use this demo wrapper to perform irreversible actions.

The paywall() export in @quietpay/merchant-sdk is Express-compatible Node middleware:

```ts
import { paywall } from "@quietpay/merchant-sdk";
app.get(
  "/v1/quote",
  paywall({ facilitatorUrl, apiKey, policy }),
  (req, res) => {
    res.json({ demo: true, data: "paid result" });
  },
);
```

The built-in Fastify app uses the same middleware against its raw Node response. Queries
are rejected unless part of the configured exact resource URL. Credentials and delivery
lease tokens stay between the resource server and facilitator. CORS exposes the payment
response headers. Build the Dockerfile from the repository root when hosting.
