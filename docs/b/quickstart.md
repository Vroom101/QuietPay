# Merchant quickstart

Accept USDT with one payer signature. Your server creates an order, the widget collects the
signature, and Quietpay sends you a signed webhook when the payment settles.

## 1. Create an order (server side)

```ts
import { createOrder } from "@quietpay/merchant-sdk";

const order = await createOrder({
  baseUrl: process.env.QUIETPAY_BASE_URL!,     // the relayer URL
  apiKey: process.env.QUIETPAY_API_KEY!,       // never expose this to a browser
  merchantId: process.env.QUIETPAY_MERCHANT_ID! as `0x${string}`,
  amount: "25000000",                          // USDT has 6 decimals: 25.00 USDT
  reference: "cart-1234",
  webhookUrl: "https://shop.example.com/webhooks/quietpay",
});
// Hand order.id to the widget: <quietpay-checkout order-id={order.id} />
```

`getOrder({ baseUrl, orderId })` reads an order and needs no API key.

## 2. Receive the webhook

Events are `payment.settled`, `payment.failed` and `payment.refunded`. Every event has a unique `id`; store the ids you
have handled and ignore repeats, because delivery is at-least-once.

```ts
import { verifyWebhook } from "@quietpay/merchant-sdk";

app.post("/webhooks/quietpay", { config: { rawBody: true } }, (req, reply) => {
  try {
    const event = verifyWebhook({
      secret: process.env.QUIETPAY_WEBHOOK_SECRET!,
      body: req.rawBody,                                   // the raw string, not parsed JSON
      signatureHeader: req.headers["quietpay-signature"] as string,
    });
    if (seen.has(event.id)) return reply.send({ ok: true }); // duplicate
    seen.add(event.id);
    if (event.type === "payment.settled") markPaid(event.data.orderId);
    reply.send({ ok: true });
  } catch {
    reply.code(400).send({ ok: false });
  }
});
```

### Signature format

`Quietpay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`

`verifyWebhook` rejects timestamps older than 5 minutes and compares in constant time. Failed
deliveries (any non-2xx) are retried with backoff: 5s, 30s, 2m, 10m, 30m, 1h, 2h, then dropped.
The same event `id` is reused on every retry.

## 3. Errors

API failures throw `QuietpayApiError` with `.status` and `.code`, one of: `order_not_found`,
`order_expired`, `bad_signature`, `amount_mismatch`, `already_settled`, `relayer_paused`,
`rate_limited`, `simulation_failed`, `fee_over_cap`, `insufficient_refund_balance`.

## Refunds

Refunds are signed on the merchant server with a separate funded `refundSigner` wallet.
The key never reaches the relayer or browser. `amount` is in token base units; omit it
for the remaining refundable amount. Pin the router and expected refund index.

```ts
import { getRefundContext, refund, getRefund } from "@quietpay/merchant-sdk";

const server = { baseUrl, apiKey, orderId };
const context = await getRefundContext(server);
// Persist the index with this business refund request; do not fetch a fresh index on a retry.
const expectedIndex = context.refundIndex;
const pending = await refund({
  ...server,
  merchantId,
  router: process.env.QUIETPAY_ROUTER_ADDRESS as `0x${string}`,
  refundSignerPrivateKey: process.env.QUIETPAY_REFUND_SIGNER_PRIVATE_KEY as `0x${string}`,
  refundIndex: expectedIndex,
  amount: "5000000", // 5 USDT
});
// Persist pending.id; poll this ID until settled or failed, or receive payment.refunded.
const status = await getRefund({ baseUrl, apiKey, refundId: pending.id as `0x${string}` });
```

The payout wallet keeps the original payment. The `refundSigner` supplies refund USDT;
it needs enough to cover the refund including any portion originally collected as a relay fee.
The operator sponsors refund gas and charges no refund fee. No token approval or gas
balance is needed on the refundSigner.

A stale SDK `refundIndex` is rejected before signing. After an uncertain response, use `listRefunds({baseUrl, apiKey, orderId})` to recover the original refund ID
by its expected index, then inspect its status before issuing a new authorization. The HTTP endpoint deduplicates
an exact signed request, including after a restart. A reverted refund keeps the original
payment paid; inspect the refund's `failureCode`, fix the cause, and sign a fresh request
at the same unused refund index. Full refunds do not make an order payable again.

See [refund API and recovery](refunds.md) for HTTP requests and webhook fields.

## Paid APIs

The SDK exports paywall() middleware for server-side x402 v2 exact EIP-3009 payments.
Run the combined facilitator with the existing relayer wallet/database and authenticate
its calls with the merchant API key. See [facilitator operations](../../packages/facilitator/README.md)
and [paid API usage](../../apps/paid-api/README.md). Resource execution follows confirmed
settlement; timeouts must retry the same signed payload rather than authorizing twice.

## Paying agent

After starting the combined facilitator and paid API, follow [the agent demo setup](../../apps/agent-demo/README.md). Set a dedicated zero-native-balance test payer key, the API origin, recipient, RPC and explorer URL, then run `pnpm --filter @quietpay/agent-demo start`. It buys a quote and signal with a default total authorization budget of 30,000 base units and prints two public payment receipts. Keep the same process alive to retry uncertain payments; sessions are in memory.
