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
- Gas tank: `getGasAccount`, `creditGasTopUp` (or `client.gas.account()` / `client.gas.creditTopUp(txHash)`). Send native WBT
  from your registered payout wallet to the relayer address shown in the account, then submit the tx hash to credit it.
  Balance = credited minus the gas spent on your orders. It is advisory only: a low or negative balance never blocks a
  payment. A too-fresh transfer fails with `topup_unconfirmed`; retry in a moment.
- `paywall()` protects an HTTP route behind an x402 payment (testnet demo only).

## Choose your billing model at initialisation

```ts
import { createQuietPay } from "@quietpay/merchant-sdk";

const qp = createQuietPay({
  baseUrl: process.env.QUIETPAY_RELAYER_URL!,
  apiKey: process.env.QUIETPAY_API_KEY!,
  merchantId: process.env.QUIETPAY_MERCHANT_ID as `0x${string}`,
  webhookSecret: process.env.QUIETPAY_WEBHOOK_SECRET!,
  billing: "both", // "product" / "one_time" (default) | "subscription" | "both"
  // subscriptionStore: yourDbStore,  // in memory by default; implement SubscriptionStore for production
});

await qp.createOrder({ amount: "8500000" });   // one-time; throws QuietpayConfigError when billing is "subscription"

const plan = await qp.subscriptions.createPlan({ name: "Pro", amount: "5000000", interval: "month" });
const sub = await qp.subscriptions.subscribe({ planId: plan.id, customer: "cust_42" });
const { order } = await qp.subscriptions.createRenewalOrder(sub.id);   // the subscriber pays this with the widget
// webhook route:
const { subscription } = await qp.subscriptions.handleWebhook({ body: rawBody, signatureHeader });
// a daily job: sweep() first (settles or past_dues orders whose webhook was missed), then due():
await qp.subscriptions.sweep();
for (const s of await qp.subscriptions.due()) { const r = await qp.subscriptions.createRenewalOrder(s.id); /* send the pay link */ }
```

How subscriptions work with gasless USDT: an EIP-3009 authorization moves one exact amount one time, so nothing can
pull funds later. Each period the SDK creates a renewal order for the plan amount (reference `sub:<id>:<period>`), and
the subscriber signs it, still paying no gas. A period counts as paid only after a verified `payment.settled` webhook
for exactly that order and amount. If the order expires unpaid (after at most 24 hours), the subscription becomes
`past_due` and you can create a new renewal. A missed webhook is recovered from the order itself the next time you call
`createRenewalOrder` or `sweep()`. Every renewal order issued for a period is remembered (`periodOrders`, at most 20): the relayer can still settle a failed or expired order late, so a `payment.settled` for any of them credits that period exactly once, and `payment.failed` only marks it `past_due`. If a second order of an already-paid period settles, it is not credited again and is listed in `duplicatePayments` so you can refund it. Due dates are the first due date plus whole periods, so a month-end billing day does not drift (Jan 31, Feb 28, Mar 31). Calls are serialised per subscription inside one process; if several processes share one database, implement the optional `SubscriptionStore.compareAndSetSubscription(prev, next)` so the SDK can detect and retry a lost race.

Build: `pnpm build` (ESM + CommonJS + type declarations in `dist/`, `@quietpay/shared` bundled in).
Check the built package: `node scripts/check-dist.mjs`. The package is not published by any automation.

Limits: testnet only; not audited; the relayer is a trusted gas sponsor; one relayer process per signing key.
