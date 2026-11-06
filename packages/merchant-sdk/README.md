# @quietpay/merchant-sdk

Server-side SDK for QuietPay: gasless USDT checkout on Whitechain Sepolia (chain 1874, official test USDT only).
Your server creates orders, reads their status, refunds, and verifies signed webhooks. The customer's browser signs
once with the QuietPay widget; a relayer pays the gas.

```ts
import { createOrder, getOrder, refund, verifyWebhook } from "@quietpay/merchant-sdk";

const order = await createOrder({
  baseUrl: process.env.QUIETPAY_RELAYER_URL!,   // https://your-relayer.example
  apiKey: process.env.QUIETPAY_API_KEY!,        // at least 24 characters, kept on your server
  merchantId: process.env.QUIETPAY_MERCHANT_ID as `0x${string}`,
  amount: "25000000",                           // 25 USDT in base units (6 decimals)
  reference: "order-1042",
  webhookUrl: "https://shop.example/webhooks/quietpay",   // public HTTPS only
});
// hand order.id to the widget on the page; pin the amount and payout your server computed

// Webhook handler: pass the RAW request body, not parsed JSON.
const event = verifyWebhook({
  secret: process.env.QUIETPAY_WEBHOOK_SECRET!,
  body: rawBody,
  signatureHeader: req.headers["quietpay-signature"] as string,
});
if (event.type === "payment.settled") { /* confirm with getOrder, then fulfil */ }
```

- `verifyWebhook` checks an HMAC-SHA256 over `timestamp.body` in constant time, rejects timestamps older than 5 minutes
  (configurable up to a day), refuses an empty secret, and can reject replayed event ids through `isReplay`.
- Refunds: `getRefundContext`, `refund`, `getRefund`, `listRefunds`. The refund is authorised by your refund-signer key
  (gasless for you; the relayer submits it).
- `paywall()` protects an HTTP route behind an x402 payment (testnet demo only).

Build: `pnpm build` (ESM + CommonJS + type declarations in `dist/`, `@quietpay/shared` bundled in).
Check the built package: `node scripts/check-dist.mjs`. The package is not published by any automation.

Limits: testnet only; not audited; the relayer is a trusted gas sponsor; one relayer process per signing key.
