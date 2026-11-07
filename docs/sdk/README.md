# QuietPay developer guide

Accept USDT on your site. Your customer approves one payment in MetaMask. They pay no gas. This guide takes you from nothing to a working checkout.

- [API reference](api-reference.md): every function, class and type in `@quietpay/merchant-sdk`.
- [Widget guide](widget.md): the checkout button your customers see.
- [Reference integration](../../apps/demo-store): a full working shop you can copy from.

> QuietPay runs on **Whitechain Sepolia testnet only**. The money is test money. The contracts are not audited. Do not use it for real funds.

## Contents

1. [What QuietPay does](#1-what-quietpay-does)
2. [Before you start](#2-before-you-start)
3. [Quick start in 5 steps](#3-quick-start-in-5-steps)
4. [Choose a billing model](#4-choose-a-billing-model)
5. [One-time payments in depth](#5-one-time-payments-in-depth)
6. [Payment links (New)](#6-payment-links-new)
7. [Subscriptions](#7-subscriptions)
8. [Refunds](#8-refunds)
9. [Webhooks reference](#9-webhooks-reference)
10. [x402 paid APIs for AI agents](#10-x402-paid-apis-for-ai-agents)
11. [Errors](#11-errors)
12. [Security checklist](#12-security-checklist)
13. [Going further](#13-going-further)

---

## 1. What QuietPay does

Normally a customer who pays in a token needs a second coin to pay the network fee ("gas"). QuietPay removes that. The customer signs a message (an EIP-3009 authorization). A relayer sends it to the chain and pays the gas. A router contract then pays you and takes a small relay fee in the same step.

```text
 Customer's browser            Your server               QuietPay relayer             Whitechain Sepolia
 ------------------            -----------               ----------------             ------------------
        |                           |                           |                            |
        | 1. "I want to buy"        |                           |                            |
        |-------------------------->|                           |                            |
        |                           | 2. create order (API key) |                            |
        |                           |-------------------------->|                            |
        |                           |<---- order id ------------|                            |
        |<-- order id --------------|                           |                            |
        | 3. widget shows order, customer signs once in MetaMask|                            |
        |------------------------------------------------------>|                            |
        |                           |                           | 4. send tx, pay the gas    |
        |                           |                           |--------------------------->|
        |                           |                           |   router pays you + fee    |
        |                           | 5. signed webhook         |                            |
        |                           |<--------------------------|                            |
        |                           | 6. re-read order, fulfil  |                            |
```

**What you pay:** a flat relay fee per payment, in USDT. The demo relayer charges 0.05 USDT (`RELAY_FEE_USDT`, default `0.05`). It comes out of the amount the customer pays: on a 25 USDT order you receive 24.95 USDT. Your customer sees only the price.

**What your customer pays:** the price. No gas, no second coin. They only need test USDT in their wallet.

## 2. Before you start

**Testnet only.** QuietPay talks to Whitechain Sepolia (chain id `1874`) and one token, the official test USDT:

| Thing | Value |
| --- | --- |
| Chain | Whitechain Sepolia, id `1874` |
| Token | `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` (USDT, 6 decimals) |
| Router | `0xb9D475cdd817900B45C356169c6FdC379B942d82` |
| Explorer | https://explorer.testnet.whitechain.io |

**Node.** Node 20 or newer (`engines.node` is `>=20`).

### Credentials

You need four things. There is no self-service sign-up yet: whoever runs the relayer registers you.

| You need | What it is | Where it goes |
| --- | --- | --- |
| Relayer URL | Base URL of the relayer, for example `http://127.0.0.1:8790` locally | `baseUrl` (server) and `relayerUrl` (widget) |
| Merchant id | 32 bytes, `0x` + 64 hex. It is `keccak256` of a name. The demo store uses the name `demo-store` | `merchantId` |
| API key | A secret of at least 24 characters. The relayer holds `apiKey:merchantId` pairs in `MERCHANT_API_KEYS` | `apiKey`, server only |
| Webhook secret | Signs the webhooks sent to you | `webhookSecret` / `secret`, server only |
| Payout address | The wallet the router pays. It is registered on the router for your merchant id | pin it in the widget as `expectedPayout` |

How the local demo derives them (see [`deploy/dev-stack.mjs`](../../deploy/dev-stack.mjs)):

- The merchant id comes from `contracts/deployments.json` (`merchants` entry for `demo-store`).
- The API key is `MERCHANT_API_KEY` from your private env file.
- The webhook secret is per merchant: `HMAC-SHA256(WEBHOOK_SECRET, merchantId in lower case)`, as hex. The dev stack computes it for you and hands it to the store as `QUIETPAY_WEBHOOK_SECRET`.
- The payout address is `MERCHANT_PAYOUT_ADDRESS`.

Keep these in environment variables. Never commit them.

```sh
QUIETPAY_BASE_URL=http://127.0.0.1:8790
QUIETPAY_API_KEY=...            # at least 24 characters
QUIETPAY_MERCHANT_ID=0x...      # 0x + 64 hex
QUIETPAY_WEBHOOK_SECRET=...
QUIETPAY_PAYOUT_ADDRESS=0x...   # 0x + 40 hex
```

To get a relayer to talk to, run the whole stack locally: see [Run the demo locally](#run-the-whole-demo-locally).

### Install

The packages are **not published to npm**. Build them from this repository.

```sh
git clone <this repository> quietpay && cd quietpay
pnpm install
```

**Option A: inside this monorepo (workspace).** Put your app in `apps/` and depend on the workspace packages. This is how the demo store does it.

```json
{
  "dependencies": {
    "@quietpay/merchant-sdk": "workspace:*",
    "@quietpay/widget": "workspace:*"
  }
}
```

```sh
pnpm install
```

**Option B: your own project, SDK from a tarball.** Build and pack the SDK, then install the `.tgz`:

```sh
cd packages/merchant-sdk
pnpm pack --pack-destination /path/to/your-project     # runs the build first (prepack)
cd /path/to/your-project
pnpm add ./quietpay-merchant-sdk-0.1.0.tgz
```

To only build it: `pnpm --filter @quietpay/merchant-sdk build` writes ESM, CommonJS and type files to `packages/merchant-sdk/dist`. Check the build with `node packages/merchant-sdk/scripts/check-dist.mjs`.

**The widget** is also not published. In a Vite app inside the monorepo use the workspace dependency above (`pnpm add @quietpay/widget` works the same way once the package is published). For a site outside the monorepo, build it with `pnpm --filter @quietpay/widget build`. It writes ES modules to `packages/widget/dist` (`index.js` for the web component, `react.js` for the React wrapper). Copy them to your site. Details in the [widget guide](widget.md).

The package names you will see in examples:

```sh
pnpm add @quietpay/merchant-sdk @quietpay/widget   # once published, or with workspace/tarball as above
```

## 3. Quick start in 5 steps

### Step 1. Create an order on your server

Your server decides the price. Never take a price from the browser.

Amounts are **token base units as a string**. USDT has 6 decimals, so `"25000000"` is 25 USDT. The SDK does not export a converter, so add this small helper to your project:

```ts
// money.ts
export function usdtToBase(amount: string): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount)) throw new Error("Not a valid USDT amount");
  const [whole, frac = ""] = amount.split(".");
  const base = BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  if (base <= 0n) throw new Error("Amount must be greater than zero");
  return base.toString();
}

export function baseToUsdt(base: string | bigint): string {
  const v = BigInt(base);
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`; // "25.000000"
}
```

(Inside the monorepo you can use `parseUsdt` and `formatUsdt` from `@quietpay/shared` instead. They do the same job. That package is private, so it is not available outside the repo.)

**With the functions API:**

```ts
import { createOrder } from "@quietpay/merchant-sdk";
import { usdtToBase } from "./money";

const order = await createOrder({
  baseUrl: process.env.QUIETPAY_BASE_URL!,
  apiKey: process.env.QUIETPAY_API_KEY!,
  merchantId: process.env.QUIETPAY_MERCHANT_ID as `0x${string}`,
  amount: usdtToBase("25"),                                // "25000000"
  reference: "cart-1234",                                  // your own id, up to 200 characters
  webhookUrl: "https://shop.example.com/webhooks/quietpay",
});
// order.id is what the browser needs
```

**With the client (`createQuietPay`).** Set things once, reuse everywhere:

```ts
import { createQuietPay } from "@quietpay/merchant-sdk";

export const qp = createQuietPay({
  baseUrl: process.env.QUIETPAY_BASE_URL!,
  apiKey: process.env.QUIETPAY_API_KEY!,
  merchantId: process.env.QUIETPAY_MERCHANT_ID as `0x${string}`,
  webhookSecret: process.env.QUIETPAY_WEBHOOK_SECRET!,
  webhookUrl: "https://shop.example.com/webhooks/quietpay",
  billing: "product",
});

const order = await qp.createOrder({ amount: "25000000", reference: "cart-1234" });
```

Return only what the browser needs, and check what the relayer gave you:

```ts
app.post("/api/checkout", async (req, res) => {
  const amount = priceTheCartOnTheServer(req.body.items);   // base units, a string
  const order = await qp.createOrder({ amount, reference: `cart-${Date.now()}` });

  if (order.amount !== amount || order.payout.toLowerCase() !== process.env.QUIETPAY_PAYOUT_ADDRESS!.toLowerCase()) {
    return res.status(502).json({ error: "could not start checkout" });
  }
  res.json({ orderId: order.id, amount: baseToUsdt(order.amount), payout: order.payout });
});
```

This mirrors `POST /api/checkout` in [`apps/demo-store/server/app.ts`](../../apps/demo-store/server/app.ts).

### Step 2. Show the checkout widget in the browser

The widget shows the price, asks MetaMask for one signature, and tells the relayer to pay. Give it the order id, the relayer URL, and the **amount and payout your server computed**. The widget refuses to sign if the order does not match them.

**React:**

```tsx
import { QuietpayCheckout } from "@quietpay/widget/react";

export function Pay({ session }: { session: { orderId: string; amount: string; payout: string } }) {
  return (
    <QuietpayCheckout
      orderId={session.orderId}
      relayerUrl="http://127.0.0.1:8790"
      expectedAmount={session.amount}      // decimal USDT string, "25.000000"
      expectedPayout={session.payout}      // your payout address
      onSettled={(order) => window.location.assign(`/success/${order.id}`)}
      onError={(e) => console.warn(e.code, e.message)}
    />
  );
}
```

**Plain HTML (web component):**

```html
<script type="module">
  import "./quietpay-widget/index.js"; // registers <quietpay-checkout>
</script>

<quietpay-checkout
  id="pay"
  order-id="0x...64 hex from your server"
  relayer-url="http://127.0.0.1:8790"
  expected-amount="25.000000"
  expected-payout="0xYourPayoutAddress"
></quietpay-checkout>

<script type="module">
  const el = document.getElementById("pay");
  el.addEventListener("quietpay:settled", (e) => console.log("paid", e.detail.order.id));
  el.addEventListener("quietpay:error", (e) => console.warn(e.detail.code, e.detail.message));
</script>
```

Note the two units: `createOrder` takes **base units** (`"25000000"`), the widget's `expectedAmount` takes a **decimal** (`"25"` or `"25.000000"`). More in the [widget guide](widget.md). The demo does exactly this in [`apps/demo-store/src/pages/Checkout.tsx`](../../apps/demo-store/src/pages/Checkout.tsx).

### Step 3. Handle the webhook

The widget's `onSettled` runs in the customer's browser. A customer can fake that. **Fulfil an order only from a verified webhook.**

Do these four things, in this order:

1. Verify the signature against the **raw** body (a string, before any JSON parsing).
2. Skip event ids you already handled (delivery is at least once).
3. Re-read the order with `getOrder` and check it is yours, settled, and the right amount.
4. Fulfil once.

```ts
import Fastify from "fastify";
import { getOrder, verifyWebhook, WEBHOOK_SIGNATURE_HEADER } from "@quietpay/merchant-sdk";

const app = Fastify();
// Keep the body as a string for this route only.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

const seen = new Set<string>(); // use a database table with a unique key in production

app.post("/webhooks/quietpay", async (req, reply) => {
  let event;
  try {
    event = verifyWebhook({
      secret: process.env.QUIETPAY_WEBHOOK_SECRET!,
      body: req.body as string,
      signatureHeader: req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string,
      isDuplicate: (id) => seen.has(id),      // optional replay guard
    });
  } catch {
    return reply.code(400).send({ error: "invalid webhook" });
  }

  if (event.data.merchantId.toLowerCase() !== process.env.QUIETPAY_MERCHANT_ID!.toLowerCase()) {
    return reply.code(400).send({ error: "wrong merchant" });
  }

  if (event.type === "payment.settled") {
    const order = await getOrder({ baseUrl: process.env.QUIETPAY_BASE_URL!, orderId: event.data.orderId });
    const ok =
      order.id.toLowerCase() === event.data.orderId.toLowerCase() &&
      order.merchantId.toLowerCase() === process.env.QUIETPAY_MERCHANT_ID!.toLowerCase() &&
      ["settled", "partially_refunded", "refunded"].includes(order.status) &&
      order.amount === event.data.amount;
    if (ok) await markPaidAndFulfil(order.id, order.amount);   // your code; must be safe to run once
  }

  seen.add(event.id);
  return { received: true };
});
```

Return a 2xx only when you are done. Any other answer makes the relayer retry. If `getOrder` fails, return a 5xx (and do not record the id yet) so the retry gets processed. The complete version is in [`apps/demo-store/server/app.ts`](../../apps/demo-store/server/app.ts).

During local development the relayer must be started with `ALLOW_PRIVATE_WEBHOOKS=1` to deliver to `127.0.0.1` (the dev stack sets it). In production your `webhookUrl` must be a public HTTPS address.

### Step 4. Show a receipt

After the widget fires `quietpay:settled`, send the customer to a page that asks **your** server whether the order is paid, and keep asking until the webhook has arrived. Do not trust the browser event.

```ts
// your server
app.get("/api/orders/:id/paid", async (req) => {
  const rec = await db.findPaid(req.params.id);           // written by your webhook handler
  return rec ? { paid: true, amount: rec.amount, txHash: rec.txHash } : { paid: false };
});
```

```tsx
// your receipt page: poll every 2 seconds until paid
const r = await fetch(`/api/orders/${orderId}/paid`).then((x) => x.json());
```

`order.txHash` is the on-chain payment. Link it as `https://explorer.testnet.whitechain.io/tx/<txHash>`. `order.explorerUrl` is set for you when the relayer provides it. See [`Success.tsx`](../../apps/demo-store/src/pages/Success.tsx).

### Step 5. Test on testnet

1. Start a relayer (see [Run the whole demo locally](#run-the-whole-demo-locally)).
2. Install MetaMask. You do not need to add the network by hand: the widget asks MetaMask to switch to Whitechain Sepolia and adds it if MetaMask does not know it.
3. Your test wallet needs **test USDT** (`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`). It does **not** need WBT (the gas coin). The relayer pays gas.
4. Click pay, approve the signature, wait a few seconds. Your webhook should fire. Check the transaction on the explorer.

If the wallet holds less USDT than the price, the widget says so before asking for a signature, with the exact numbers.

By default the relayer limits a single payer to 100 USDT per rolling 24 hours (`PAYER_CAP_USDT`). A payer over the cap gets `rate_limited`.

## 4. Choose a billing model

Choose once, when you create the client. `billing` accepts:

| Value | Meaning | One-time orders | Payment links | Subscriptions |
| --- | --- | --- | --- | --- |
| `"product"` or `"one_time"` (default) | Selling things once. `"product"` is another name for `"one_time"` | yes | yes | blocked |
| `"subscription"` | Recurring plans only | blocked | blocked | yes |
| `"both"` | Everything | yes | yes | yes |

A blocked method throws `QuietpayConfigError`, for example `Subscriptions is turned off: this client was created with billing "one_time"`. This stops a subscription-only business from creating stray one-time orders by mistake.

```ts
const qp = createQuietPay({ baseUrl, apiKey, merchantId, billing: "both" });
qp.billing;   // "both"
qp.supports;  // { oneTime: true, subscription: true }
```

## 5. One-time payments in depth

### Amounts

- Always **base units, as a string of digits**: `"1"` is 0.000001 USDT, `"1000000"` is 1 USDT.
- Positive integers only. No decimals, no signs, no exponent. A bad amount fails with a validation error before any request is sent.
- Never use JavaScript `number` for money. Use strings and `BigInt`.

| You want | Base units |
| --- | --- |
| 0.05 USDT | `"50000"` |
| 1 USDT | `"1000000"` |
| 25.5 USDT | `"25500000"` |

In the widget (`expectedAmount`) and in screens, use a decimal string such as `"25.5"`. Inside this repo, `parseUsdt("25.5")` gives `25500000n` and `formatUsdt("25500000")` gives `"25.500000"` (always six decimals; it never rounds). `formatUsdtShort` truncates for display only. Do not use it for anything you store or sign.

### Expiry

`expiresInSeconds` is an integer from **60 to 86400** (one minute to one day). If you leave it out the relayer uses 900 seconds (15 minutes). An unpaid order becomes `expired`. Start a new order for a new attempt.

### References

`reference` is your own label (up to 200 characters), for example a cart or invoice number. It comes back on the order and on every webhook. The client refuses two prefixes, because the SDK uses them itself: `sub:<id>:<n>` (subscription renewals) and `link:<id>:<n>` (payment links).

### Order statuses

| Status | Meaning | What you do |
| --- | --- | --- |
| `created` | Order exists, customer has not paid | Wait, or let it expire |
| `pending` | Customer signed, the payment is on its way to the chain | Wait for the webhook |
| `settled` | Paid. You and the relay fee have been paid by the router | Fulfil (once) |
| `failed` | The attempt failed (see `failureCode`). The same order can be retried with a new signature | Usually nothing; the widget offers "Try again" |
| `expired` | Time ran out before payment | Create a new order |
| `partially_refunded` | Paid, and part of it refunded | Nothing; this still counts as paid |
| `refunded` | Paid, then fully refunded | Take back access or goods as your policy says |

Treat `settled`, `partially_refunded` and `refunded` as "was paid". The order object (`Order`) is described in the [API reference](api-reference.md#order).

### Reading orders

```ts
const order = await qp.getOrder(orderId);     // public; no API key needed
const mine = await qp.listOrders();           // your orders only; needs the API key
```

## 6. Payment links (New)

A payment link lets you take a payment **without a website**. You create a link for a title and an amount. You send the customer the URL. Each time someone opens it, a fresh checkout order for that exact amount is created.

### From the dashboard

Open the merchant dashboard (the demo runs at `http://localhost:5174` and you sign in with MetaMask). In the **Billing** area choose **Payment link**, enter a title, an amount and options, and copy the URL. The demo store hosts the page for every link at `/pay/<id>`, for example `http://localhost:5173/pay/link_ab12...`. The page shows the title and amount, creates the order, and shows the widget.

### From code

Links need `billing` to be `"product"`, `"one_time"` or `"both"`.

```ts
import { createQuietPay } from "@quietpay/merchant-sdk";

const qp = createQuietPay({
  baseUrl: process.env.QUIETPAY_BASE_URL!,
  apiKey: process.env.QUIETPAY_API_KEY!,
  merchantId: process.env.QUIETPAY_MERCHANT_ID as `0x${string}`,
  webhookSecret: process.env.QUIETPAY_WEBHOOK_SECRET!,
  webhookUrl: "https://shop.example.com/webhooks/quietpay",
  billing: "product",
  // paymentLinkStore: yourDatabaseStore,      // in memory by default
  // linkCheckoutExpiresInSeconds: 1800,       // 60..86400, default 1800
});

const link = await qp.links.create({
  title: "Logo design, deposit",     // 1-80 characters
  amount: "50000000",                // 50 USDT in base units
  description: "50% up front",       // optional, up to 280 characters
  singleUse: true,                   // default true: stops after one payment
  expiresInSeconds: 7 * 86400,       // optional, 60 seconds to 90 days
  // id: "deposit-1042",             // optional; 1-64 of A-Z a-z 0-9 _ . : -
});
const url = `https://shop.example.com/pay/${link.id}`;   // your page; see below

await qp.links.get(link.id);        // PaymentLink | undefined
await qp.links.list();              // newest first
await qp.links.deactivate(link.id); // stops NEW checkouts
```

Your pay page opens a checkout for the visitor and shows the widget:

```ts
const { link: current, order } = await qp.links.checkout(link.id);
// order.reference is "link:<id>:<n>"
// return { orderId: order.id, amount: baseToUsdt(order.amount), payout: order.payout } to the browser
```

`checkout` throws `QuietpayConfigError` if the link is deactivated, has expired, or is single-use and already paid. Several open orders per link are fine (customers retry). A link counts as paid only when a verified `payment.settled` webhook names one of the orders issued for it.

### Webhook for links

One call verifies the signature and applies the event to your subscriptions and your links:

```ts
const { event, subscription, link } = await qp.links.handleWebhook({
  body: rawBody,                       // the raw string
  signatureHeader: req.headers["quietpay-signature"] as string,
});
```

`link` is the link the event changed (or `undefined`). `subscription` is set only if the event was a subscription renewal and billing includes subscriptions. This helper does **not** replace the checks in [step 3](#step-3-handle-the-webhook): still skip repeated event ids and re-read the order with `getOrder`. If you want to apply an already verified event yourself, use `qp.links.applyWebhook(event)`.

> The helper is `qp.links.handleWebhook`. There is no `qp.handleWebhook`. `qp.subscriptions.handleWebhook` is a separate helper that applies to subscriptions only.

### Things to know

- **Deactivating** stops new checkouts. An order issued before you deactivated can still be paid, and it still counts for the link.
- **Single-use links:** if a second payment settles on a link that is already paid, it is not counted. Its order id goes in `link.duplicatePayments`. **Refund it.**
- `link.status` is `active`, `paid` or `deactivated`. A link past its `expiresAt` is not given a separate status in the SDK object; compare `expiresAt` to the clock if you need to show "expired".
- The default store is in memory and is lost on restart. Pass your own `paymentLinkStore`. The demo store keeps links in a JSON file. If several processes share a database, implement `compareAndSetLink` so two workers cannot clash.

## 7. Subscriptions

### Why it works this way

An EIP-3009 authorization moves **one exact amount, one time**. It cannot give anyone permission to pull money later. So a QuietPay subscription is **pay per period**: each period the SDK creates a *renewal order* for the plan price, and the subscriber signs it with the widget, still paying no gas. You send them the pay link (email, in-app prompt, a page).

A period counts as paid only after a verified `payment.settled` webhook for exactly that order and amount.

### Plans, subscribers, renewals

```ts
const qp = createQuietPay({
  baseUrl, apiKey, merchantId, webhookSecret,
  webhookUrl: "https://shop.example.com/webhooks/quietpay",
  billing: "subscription",          // or "both"
  // subscriptionStore: yourDatabaseStore,
  // renewalExpiresInSeconds: 86400,  // 60..86400, default 86400
});

const plan = await qp.subscriptions.createPlan({
  name: "Pro",
  amount: "5000000",                // 5 USDT per period
  interval: "month",                // "day" | "week" | "month" | "year"
  intervalCount: 1,                 // 1..36; 3 with "month" is quarterly
});

const sub = await qp.subscriptions.subscribe({ planId: plan.id, customer: "cust_42" });
// first renewal is due immediately

const { subscription, order } = await qp.subscriptions.createRenewalOrder(sub.id);
// order.reference is "sub:<subscriptionId>:<period>"
// send the subscriber to a page with the widget for order.id
```

`createRenewalOrder` is safe to call twice: it returns the still-open order for the period instead of making a second payable one. It throws `QuietpayConfigError` if the subscription is cancelled, not due yet, or has too many unpaid orders (20) for the period. It first re-reads existing orders, so a missed webhook is recovered from the order itself.

Other calls: `qp.subscriptions.listPlans()`, `.get(id)`, `.list()`, `.cancel(id)`.

### Webhook

```ts
// in your webhook route, after your own duplicate and getOrder checks
const { event, subscription } = await qp.subscriptions.handleWebhook({
  body: rawBody,
  signatureHeader,
});
```

Or `await qp.subscriptions.applyWebhook(event)` for an event you verified yourself. Both return the subscription that changed, or `undefined`.

What happens:

- `payment.settled` for any renewal order issued for the unpaid period (exact plan amount, your merchant) credits the period **once**. The next due date moves forward.
- If a *second* order for an already-paid period settles, it is **not** credited. It is listed in `subscription.duplicatePayments` so you can refund it.
- `payment.failed` marks the subscription `past_due`. It is advisory: the relayer can still settle a failed or expired order late, so the order ids are kept and a late `payment.settled` still credits the period.
- Due dates are the first due date plus whole periods, so a billing day at month end does not drift (Jan 31, Feb 28, Mar 31). Paying late does not shift later dates.

### The daily job

Run this once a day (cron, a scheduled function):

```ts
await qp.subscriptions.sweep();                       // settle or past_due orders whose webhook was missed
for (const s of await qp.subscriptions.due()) {       // active, due, and no live open order
  const { order } = await qp.subscriptions.createRenewalOrder(s.id);
  await sendPayLink(s.customer, order.id);            // your code
}
```

### Statuses

| Status | Meaning |
| --- | --- |
| `active` | In good standing |
| `past_due` | A renewal order expired or failed without payment. Create a new renewal order; paying it returns the subscription to `active` |
| `cancelled` | No more renewals. An already open order can still be paid and recorded, but nothing new is created |

### Stores and several servers

The default `memorySubscriptionStore()` is lost on restart. In production give `subscriptionStore` an object with `getPlan`, `putPlan`, `listPlans`, `getSubscription`, `putSubscription`, `listSubscriptions`. Calls are serialised per subscription **inside one process only**. If several processes share one database, also implement `compareAndSetSubscription(prev, next)`: store `next` only if the stored row still equals `prev`, and return `false` otherwise. Without it, two workers can create two payable orders for one period. The demo's JSON-file store in [`apps/demo-store/server/subscriptions.ts`](../../apps/demo-store/server/subscriptions.ts) is a worked example.

## 8. Refunds

Refunds are signed by a separate **refund-signer key** that you control. The key stays on your server. It is never sent to the relayer or the browser. The refund-signer wallet must hold the USDT to be refunded (the relayer pays the gas). The payout wallet keeps the original payment.

```ts
import { getRefundContext, refund, getRefund, listRefunds } from "@quietpay/merchant-sdk";

const server = {
  baseUrl: process.env.QUIETPAY_BASE_URL!,
  apiKey: process.env.QUIETPAY_API_KEY!,
  orderId: order.id as `0x${string}`,
};

// 1. Read the current state. Save refundIndex with your own refund request, so a retry reuses it.
const context = await getRefundContext(server);
// context: { amountPaid, refunded, refundIndex, refundBalance, refundSigner, router, ... }

// 2. Sign and send. Omit `amount` to refund everything that is left.
const pending = await refund({
  ...server,
  merchantId: process.env.QUIETPAY_MERCHANT_ID as `0x${string}`,
  router: process.env.QUIETPAY_ROUTER_ADDRESS as `0x${string}`,
  refundSignerPrivateKey: process.env.QUIETPAY_REFUND_SIGNER_PRIVATE_KEY as `0x${string}`,
  refundIndex: context.refundIndex,
  amount: "5000000",                    // partial: 5 USDT
});

// 3. Follow it. Save pending.id. Or wait for the payment.refunded webhook.
const status = await getRefund({ baseUrl: server.baseUrl, apiKey: server.apiKey, refundId: pending.id as `0x${string}` });
// status.status: "pending" | "settled" | "failed"
```

Rules:

- **Partial refunds:** pass `amount` in base units. You can refund several times until the order is fully refunded. The order goes `settled`, then `partially_refunded`, then `refunded`.
- **The refund index** counts refunds on an order (0, 1, 2...). `refund()` refuses to sign if the index has changed since you read it. This stops an accidental double refund on a retry.
- **Checks before signing:** `refund()` throws a plain `Error` if the order, merchant, router, chain or token do not match what you configured, if the key is not the merchant's registered refund signer, or if the amount is not valid.
- **Not enough refund funds:** throws `QuietpayApiError` with code `insufficient_refund_balance`. Top up the refund-signer wallet with test USDT and try again.
- **Uncertain answer (timeout)?** Do not sign a new refund. Call `listRefunds({ baseUrl, apiKey, orderId })`, find the refund at your expected index, and read its status with `getRefund`.
- **A failed refund** leaves the payment paid. Check `failureCode`, fix the cause, and sign a new request at the same unused index.
- Refunds go back to the payer's address. The relay fee is **not** returned (see the FAQ).

More detail: [refund API and recovery](../b/refunds.md) and [dashboard refunds](../b/dashboard-refunds.md).

## 9. Webhooks reference

### Events

| `type` | Sent when |
| --- | --- |
| `payment.settled` | The payment is final on-chain |
| `payment.failed` | The payment attempt failed (`data.failureCode` says why) |
| `payment.refunded` | A refund settled |

Body (JSON):

```json
{
  "id": "evt_...",
  "type": "payment.settled",
  "createdAt": 1790000000,
  "data": {
    "orderId": "0x...64 hex",
    "merchantId": "0x...64 hex",
    "amount": "25000000",
    "fee": "50000",
    "payer": "0x...40 hex",
    "payout": "0x...40 hex",
    "txHash": "0x...64 hex",
    "reference": "cart-1234"
  }
}
```

| Field | Notes |
| --- | --- |
| `id` | Unique per event, the same on every retry. Use it to ignore repeats |
| `createdAt` | Unix seconds |
| `data.orderId`, `data.merchantId` | 32-byte hex |
| `data.amount`, `data.fee` | Base units, strings |
| `data.payout` | Address that was paid |
| `data.payer`, `data.txHash`, `data.reference` | Optional |
| `data.failureCode` | Optional; on `payment.failed` |
| `data.refundId`, `data.refundAmount`, `data.totalRefunded`, `data.refundIndex` | On `payment.refunded` (all four are always present) |

### Signature

Header: `Quietpay-Signature: t=<unix seconds>,v1=<hex>`. The SDK exports the name as `WEBHOOK_SIGNATURE_HEADER`. HTTP header names are case-insensitive, and Node lower-cases them: `req.headers["quietpay-signature"]`.

`v1` is the HMAC-SHA256 of `"<t>.<raw body>"` using your webhook secret. `verifyWebhook` checks it in constant time. It also:

- refuses an empty secret;
- rejects a timestamp more than **300 seconds** from now. You can set `toleranceSeconds` (greater than 0, up to 86400). Anything else throws `WebhookVerificationError`;
- checks the body is a valid QuietPay event;
- calls your optional `isDuplicate(eventId)` **after** the signature checks out. Return `true` to reject a repeat. Record the id yourself.

All failures throw `WebhookVerificationError`. Answer 400 to those.

### Retries

Any non-2xx answer (and a redirect) counts as a failure. The relayer retries with growing waits: 5 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, and gives up after 7 attempts. Each attempt is signed again with a fresh timestamp, but the event `id` stays the same. So your handler must be idempotent.

### Testing without a chain

`pnpm --filter @quietpay/demo-store simulate-webhook` sends a signed test event to a store. See [`apps/demo-store/scripts/simulate-webhook.ts`](../../apps/demo-store/scripts/simulate-webhook.ts).

## 10. x402 paid APIs for AI agents

x402 lets a program pay per request. A server answers `402 Payment Required` with a price. The caller signs an EIP-3009 transfer and retries. QuietPay settles it gaslessly through a **facilitator**, and the money goes straight to you.

**Server side (you sell an API).** `paywall()` is Express-compatible middleware. Your handler runs only after the payment is confirmed on-chain.

```ts
import express from "express";
import { paywall } from "@quietpay/merchant-sdk";

const app = express();

app.get(
  "/v1/quote",                                     // the path must match policy.resource.url exactly
  paywall({
    facilitatorUrl: process.env.QUIETPAY_FACILITATOR_URL!,
    apiKey: process.env.QUIETPAY_API_KEY!,
    // timeoutMs: 10000,
    policy: {
      merchantId: process.env.QUIETPAY_MERCHANT_ID!,
      resource: { url: "https://api.example.com/v1/quote", description: "Market quote", mimeType: "application/json" },
      requirements: {
        scheme: "exact",
        network: "eip155:1874",
        asset: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7",
        amount: "10000",                           // 0.01 USDT in base units
        payTo: process.env.QUIETPAY_PAYOUT_ADDRESS!,
        maxTimeoutSeconds: 60,
        extra: { name: "Tether USD", version: "1", assetTransferMethod: "eip3009", paymentFlow: "upfront" },
      },
    },
  }),
  (_req, res) => res.json({ data: "paid result" }),
);
```

Rules to know: only `GET`, and the request URL must equal the policy resource URL. Keep handlers read-only or idempotent, because a failed delivery may be retried once. A payment of unknown status returns `503 payment_status_unknown`, and the caller should retry the same signed payload, never sign a new one.

**Agent side (a program that pays).** `@quietpay/agent-client` (in `packages/agent-client`) wraps `fetch`, signs the payment, and enforces budgets:

```ts
import { createAgent } from "@quietpay/agent-client";
import { privateKeyToAccount } from "viem/accounts";

const agent = createAgent({
  signer: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
  chainId: 1874,
  asset: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7",
  domainName: "Tether USD",
  domainVersion: "1",
  allowedOrigins: ["https://api.example.com"],
  allowedPayTo: ["0xYourPayoutAddress"],
  perCallLimit: 20_000n,        // 0.02 USDT
  sessionBudget: 30_000n,       // 0.03 USDT
  explorerUrl: "https://explorer.testnet.whitechain.io",
});
const res = await agent.fetch("https://api.example.com/v1/quote");
```

Read the full options and retry rules in [`packages/agent-client/README.md`](../../packages/agent-client/README.md). The server pieces are in [`packages/facilitator/README.md`](../../packages/facilitator/README.md) and [`apps/paid-api/README.md`](../../apps/paid-api/README.md). Agent payments go straight to your address with no router and no relay fee. State is in memory in the agent client.

## 11. Errors

The SDK throws five kinds of error.

### `QuietpayApiError`

The relayer answered with a non-2xx status. It has `status` (HTTP), `code` and `message`.

| `code` | HTTP | Meaning | What to do |
| --- | --- | --- | --- |
| `order_not_found` | 404 | No such order | Check the id. Start a new order |
| `order_expired` | 410 | Order timed out | Create a new order |
| `bad_signature` | 400 | The signature did not verify | Ask the customer to try again |
| `amount_mismatch` | 400 | The amount differs from the order | Show the customer the real price; create a new order |
| `already_settled` | 409 | Order already paid (or being paid) | Treat as paid. Do not charge again |
| `relayer_paused` | 503 | Payments paused (also used for gas ceiling) | Retry in a moment |
| `rate_limited` | 429 | Too many requests, or a payer over the cap | Wait a minute. Back off |
| `simulation_failed` | 422 | The payment would fail (often not enough USDT; also "merchant not registered") | Customer checks balance. Check your merchant registration |
| `fee_over_cap` | 422 | The relay fee is above the allowed cap | Retry later; tell the relayer operator |
| `insufficient_refund_balance` | 422 | The refund-signer wallet holds too little USDT | Top it up and retry |
| `payment_replayed` | 409 | That approval was already used | Start a new payment |
| `budget_exceeded` | 503 | The relayer's gas budget is used up for now | Retry later |
| `invalid_amount` | 400 | Not a valid amount | Fix the amount |
| `unknown` | any | Not a QuietPay error body (or non-JSON) | Log `status`; retry on 5xx |

Also: `getOrder` throws `QuietpayApiError(400, "unknown", ...)` for an order id that is not `0x` + 64 hex.

```ts
import { QuietpayApiError } from "@quietpay/merchant-sdk";
try {
  await qp.createOrder({ amount: "25000000" });
} catch (e) {
  if (e instanceof QuietpayApiError && e.code === "rate_limited") { /* back off */ }
  else throw e;
}
```

### Validation errors

`createOrder` checks its input with a schema first. A bad amount, a `reference` over 200 characters, an `expiresInSeconds` outside 60..86400, or a bad `merchantId` throws a `ZodError` before any request is sent.

### `QuietpayConfigError`

Your setup or usage is wrong, or a rule of the SDK stopped you. Examples: an unknown `billing` value; `merchantId` not 32-byte hex; empty `apiKey`; a method used while its billing model is off; `webhookSecret` missing for a webhook helper; unknown plan, subscription or link; a cancelled subscription; a renewal that is not due yet; a deactivated, expired or already paid link; `link:` and `sub:` references used in a one-time order. Fix the code or the data. Do not retry.

### `WebhookVerificationError`

Thrown by `verifyWebhook` (and the `handleWebhook` helpers) for: empty secret, missing header, bad tolerance, wrong signature or old timestamp, body that is not JSON or not a QuietPay event, duplicate id. Answer 400. Do not process the request. If every webhook fails, check that you pass the **raw** body and the right per-merchant secret.

### Plain `Error`

`refund()` throws a plain `Error` when its pre-signing checks fail (wrong order, router, key or amount; changed refund index). Read the message.

## 12. Security checklist

- [ ] The API key lives on your server only. It is never in browser code, `VITE_*` variables, or git.
- [ ] The refund-signer key is on your server only, in a secret store.
- [ ] You price the order on the server. The browser sends item ids, never a price.
- [ ] You pin `expectedAmount` and `expectedPayout` in the widget, from your server's answer.
- [ ] Webhooks are verified with the **raw** body and your webhook secret.
- [ ] You skip event ids you have seen, using a database with a unique key (not memory).
- [ ] You re-read the order with `getOrder` before you fulfil, and compare merchant, status and amount.
- [ ] You fulfil from the webhook, not from the browser's `onSettled`.
- [ ] You check `event.data.merchantId` is yours.
- [ ] Your webhook URL is HTTPS and public. The relayer will not deliver to private addresses unless the operator sets `ALLOW_PRIVATE_WEBHOOKS` (local development).
- [ ] The checkout-creating endpoint is rate limited per IP.
- [ ] Secrets are in env files that are in `.gitignore`. Keys that leaked once are replaced.
- [ ] You use a persistent store for subscriptions and links, with `compareAndSet*` if several processes run.
- [ ] You refund orders listed in `duplicatePayments`.

## 13. Going further

### Run the whole demo locally

The dev stack starts the relayer (with the x402 facilitator), a ledger, the demo store (server and web), the paid API and the merchant dashboard, all against the real testnet:

```sh
pnpm install
node --env-file=<path to your private env file> deploy/dev-stack.mjs
```

The env file (gitignored, never printed) must provide `RPC_URL`, `RELAYER_PRIVATE_KEY`, `OPERATOR_TOKEN`, `WEBHOOK_SECRET`, `MERCHANT_API_KEY`, `MERCHANT_PAYOUT_ADDRESS` and `REFUND_SIGNER_PRIVATE_KEY`. It also reads `ROUTER_ADDRESS` and `USDT_ADDRESS` (they must match the official ones), and optionally `MERCHANT_WALLETS`, `QUIETPAY_BILLING`. Add `--fresh` for a clean state. Then open:

| URL | What |
| --- | --- |
| http://localhost:5173 | Store for customers (payment links at `/pay/<id>`) |
| http://localhost:5174 | Merchant dashboard (sign in with MetaMask) |
| http://127.0.0.1:8790 | Relayer |
| http://127.0.0.1:3001 | Store API |
| http://127.0.0.1:8791/v1/quote | Paid API (x402) |

Mock relayer for frontend work without a chain: `pnpm --filter @quietpay/shared mock` (port 8787). The mock does not send webhooks.

### Reference integration

| File | What it shows |
| --- | --- |
| [`apps/demo-store/server/app.ts`](../../apps/demo-store/server/app.ts) | `/api/checkout` and the full webhook handler |
| [`apps/demo-store/server/subscriptions.ts`](../../apps/demo-store/server/subscriptions.ts) | Plans, subscribe, renewals with the SDK |
| [`apps/demo-store/server/payment-links.ts`](../../apps/demo-store/server/payment-links.ts) | Payment links on top of `qp.links` |
| [`apps/demo-store/src/pages/Checkout.tsx`](../../apps/demo-store/src/pages/Checkout.tsx) | The React widget with pinned amount and payout |
| [`apps/demo-store/src/pages/Success.tsx`](../../apps/demo-store/src/pages/Success.tsx) | A receipt that waits for the webhook |
| [`docs/b/quickstart.md`](../b/quickstart.md) | Short merchant quickstart |

### FAQ

**Why do I see a relay fee?** The relayer pays gas for your customers. The flat fee (0.05 USDT in the demo) pays for that. It is taken from the payment, so you receive `amount - fee`. The customer pays only the price.

**Can customers pay without MetaMask?** The widget also has a "Pay with demo wallet" button. It makes a random key stored in the browser. It is for demos only: clearing site data loses the key and any funds in it. Real customers should use MetaMask (or another EIP-1193 wallet).

**Why is net revenue negative after a full refund?** A full refund sends the whole price back to the customer, but the relay fee was already spent and is not returned. The payout received `amount - fee`, and the refund came from your refund-signer wallet. So net revenue is `amount - fee - refunded`, which is `-fee` after a full refund. The ledger shows this on purpose instead of hiding the loss.

**Can I use this on mainnet?** No. It is built for Whitechain Sepolia testnet and the official test USDT, and the code refuses other chains and tokens. The contracts are not audited.

**Why does the customer sign for `expectedAmount` in decimals but I create orders in base units?** Two layers: the API speaks exact integers, the widget speaks what people read. Convert with the helper in step 1.

**How long do I wait for a webhook?** Usually seconds after the customer signs. If it has not arrived, `getOrder` tells you the truth.

### Limitations

- Testnet only (chain 1874, official test USDT only).
- The contracts, relayer and SDK are not audited. They were tested and attacked by AI-driven tests, with no human audit.
- The relayer is a trusted gas sponsor: it can pause or censor, but cannot redirect funds.
- The packages are not published to npm.
- Subscriptions are pay-per-period; there is no automatic pull of funds.
- The browser demo wallet is not for real money.
- One relayer process per signing key.
