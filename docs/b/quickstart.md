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

Events are `payment.settled` and `payment.failed`. Every event has a unique `id`; store the ids you
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
`rate_limited`, `simulation_failed`, `fee_over_cap`.

## Refunds

`refund()` is a stub that throws. Refunds ship in P1.
