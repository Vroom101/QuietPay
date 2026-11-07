# API reference: `@quietpay/merchant-sdk`

Everything the package exports. For a guided tour, read the [developer guide](README.md) first.

Conventions used below:

- `Hex` means a `` `0x${string}` `` string.
- **Amounts** are token base units as strings (USDT has 6 decimals): `"25000000"` is 25 USDT.
- **Times** are Unix seconds.
- Functions that talk to the relayer accept an optional `fetch` (to replace the global one in tests).
- Server side only. Do not import the API-key functions into browser code.

## Contents

- [Functions](#functions): [createOrder](#createorder), [getOrder](#getorder), [listOrders](#listorders), [verifyWebhook](#verifywebhook), [getRefundContext](#getrefundcontext), [refund](#refund), [getRefund](#getrefund), [listRefunds](#listrefunds), [paywall](#paywall), [addInterval](#addinterval)
- [Client](#client): [createQuietPay](#createquietpay), [client.createOrder and friends](#the-client-object), [client.subscriptions](#clientsubscriptions), [client.links](#clientlinks-new)
- [Stores](#stores): [memorySubscriptionStore](#memorysubscriptionstore), [memoryPaymentLinkStore](#memorypaymentlinkstore), [SubscriptionStore](#subscriptionstore), [PaymentLinkStore](#paymentlinkstore)
- [Errors](#error-classes): [QuietpayApiError](#quietpayapierror), [QuietpayConfigError](#quietpayconfigerror), [WebhookVerificationError](#webhookverificationerror)
- [Constants](#constants)
- [Types](#types)

---

## Functions

### createOrder

Creates an order on the relayer. Call it on your server.

```ts
function createOrder(opts: CreateOrderOptions): Promise<Order>
```

| Param (`CreateOrderOptions`) | Type | Required | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `string` | yes | Relayer URL. Trailing slashes are removed |
| `apiKey` | `string` | yes | Sent as a Bearer token |
| `merchantId` | `Hex` | yes | 0x + 64 hex |
| `amount` | `string` | yes | Positive integer base units, fits in uint256 |
| `reference` | `string` | no | Up to 200 characters |
| `webhookUrl` | `string` | no | `http(s)` URL, up to 2048 characters, no username or password. The relayer refuses private targets unless its operator allows them |
| `expiresInSeconds` | `number` | no | Integer 60..86400. Relayer default 900 |
| `fetch` | `typeof fetch` | no | For tests |

**Returns** the [`Order`](#order). Its `id` is what the widget needs.
**Throws** `ZodError` for invalid input (before any request); `QuietpayApiError` for a relayer error.

```ts
const order = await createOrder({
  baseUrl: process.env.QUIETPAY_BASE_URL!,
  apiKey: process.env.QUIETPAY_API_KEY!,
  merchantId: process.env.QUIETPAY_MERCHANT_ID as `0x${string}`,
  amount: "25000000",
  reference: "cart-1234",
});
```

### getOrder

Reads one order. Public: no API key.

```ts
function getOrder(opts: GetOrderOptions): Promise<Order>
```

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `string` | yes | |
| `orderId` | `string` | yes | `0x` + 64 hex. A plain string is accepted and checked at runtime |
| `fetch` | `typeof fetch` | no | |

**Returns** [`Order`](#order). **Throws** `QuietpayApiError` (`400 "unknown"` for a malformed id; `order_not_found` if missing).

```ts
const order = await getOrder({ baseUrl, orderId });
if (order.status === "settled") { /* paid */ }
```

### listOrders

Lists your orders (the merchant of the API key only).

```ts
function listOrders(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch }): Promise<Order[]>
```

**Returns** `Order[]`. These include `gasWei` (the gas the relayer spent on the order). **Throws** `QuietpayApiError`.

### verifyWebhook

Checks a webhook's signature and returns the parsed event.

```ts
function verifyWebhook(opts: VerifyWebhookOptions): WebhookEvent
```

| Param | Type | Required | Notes |
| --- | --- | --- | --- |
| `secret` | `string` | yes | Your webhook secret. An empty or blank secret is refused |
| `body` | `string` | yes | The raw request body, before JSON parsing |
| `signatureHeader` | `string` | yes | Value of `Quietpay-Signature` |
| `toleranceSeconds` | `number` | no | Default 300. Must be finite, greater than 0, at most 86400 |
| `nowSeconds` | `number` | no | For tests |
| `isDuplicate` | `(eventId: string) => boolean` | no | Called only after the signature and time check pass. Return `true` to reject a repeat. You must record ids yourself |

**Returns** [`WebhookEvent`](#webhookevent). **Throws** `WebhookVerificationError`.

```ts
const event = verifyWebhook({
  secret: process.env.QUIETPAY_WEBHOOK_SECRET!,
  body: rawBody,
  signatureHeader: req.headers["quietpay-signature"] as string,
});
```

### getRefundContext

Reads what you need before a refund. Needs the API key.

```ts
function getRefundContext(opts: { baseUrl: string; apiKey: string; orderId: Hex; fetch?: typeof fetch }): Promise<RefundContext>
```

**Returns** [`RefundContext`](#refundcontext). **Throws** `QuietpayApiError`.

### refund

Signs a refund with your refund-signer key and sends it to the relayer. The relayer pays the gas.

```ts
function refund(opts: RefundOptions): Promise<Refund>
```

| Param (`RefundOptions`) | Type | Required | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `string` | yes | |
| `apiKey` | `string` | yes | |
| `merchantId` | `Hex` | yes | |
| `orderId` | `Hex` | yes | |
| `router` | `Hex` | yes | Pin the router address you expect |
| `refundSignerPrivateKey` | `Hex` | yes | Server only. Must belong to the merchant's registered refund signer |
| `refundIndex` | `number` | yes | The index you read from `getRefundContext`. A changed index is refused |
| `amount` | `string` | no | Base units. Omit to refund all that is left |
| `chainId` | `number` | no | Default 1874 |
| `tokenAddress` | `Hex` | no | Default the official USDT |
| `tokenDomain` | `{ name: string; version: string }` | no | Default `{ name: "Tether USD", version: "1" }` |
| `fetch` | `typeof fetch` | no | |
| `nowSeconds` | `number` | no | For tests. The signature is valid from 5 s before to 300 s after this time |

**Returns** the [`Refund`](#refund-type) (usually `pending`).
**Throws** `Error` if the context does not match your configuration, the index changed, the key is not the merchant's refund signer, or the amount is invalid; `QuietpayApiError` with `insufficient_refund_balance` when the refund-signer wallet is short; other `QuietpayApiError`s from the relayer.

```ts
const r = await refund({
  baseUrl, apiKey, orderId, merchantId,
  router: process.env.QUIETPAY_ROUTER_ADDRESS as `0x${string}`,
  refundSignerPrivateKey: process.env.QUIETPAY_REFUND_SIGNER_PRIVATE_KEY as `0x${string}`,
  refundIndex: context.refundIndex,
  amount: "5000000",
});
```

### getRefund

```ts
function getRefund(opts: { baseUrl: string; apiKey: string; refundId: Hex; fetch?: typeof fetch }): Promise<Refund>
```

**Returns** the [`Refund`](#refund-type). **Throws** `QuietpayApiError`.

### listRefunds

Lists the refunds of one order. Use it to recover a refund id after an uncertain response.

```ts
function listRefunds(opts: { baseUrl: string; apiKey: string; orderId: Hex; fetch?: typeof fetch }): Promise<Refund[]>
```

**Returns** `Refund[]`. **Throws** `QuietpayApiError`.

### paywall

Express-compatible middleware that puts a `GET` route behind an x402 payment. The route handler runs only after the payment is confirmed and delivery is claimed.

```ts
function paywall(options: PaywallOptions): (req, res, next) => Promise<void>
```

| Param (`PaywallOptions`) | Type | Required | Notes |
| --- | --- | --- | --- |
| `facilitatorUrl` | `string` | yes | Base URL of the facilitator |
| `apiKey` | `string` | yes | Your merchant API key |
| `policy` | `X402Policy` | yes | `{ merchantId, resource: { url, description?, mimeType? }, requirements: { scheme: "exact", network, asset, amount, payTo, maxTimeoutSeconds, extra } }` |
| `timeoutMs` | `number` | no | Per call to the facilitator. Default 10000 |
| `fetch` | `typeof fetch` | no | |

**Behaviour:** answers `402` with a `PAYMENT-REQUIRED` header when there is no payment, `400` for a bad payload or a wrong resource, and `503 payment_status_unknown` when the payment status cannot be established (the caller must retry the same signed payload). **Throws** at creation if `policy` is invalid (`ZodError`). See the [x402 section](README.md#10-x402-paid-apis-for-ai-agents) for a full example.

### addInterval

The date maths the subscriptions use.

```ts
function addInterval(fromSeconds: number, interval: Interval, count?: number): number
```

| Param | Type | Notes |
| --- | --- | --- |
| `fromSeconds` | `number` | Start, Unix seconds |
| `interval` | `Interval` | `"day" \| "week" \| "month" \| "year"` |
| `count` | `number` | Default 1 |

**Returns** Unix seconds. Months and years clamp to the last day of the month in UTC (Jan 31 + 1 month = Feb 28 or 29).

---

## Client

### createQuietPay

One configured client with the billing model fixed at creation.

```ts
function createQuietPay(init?: QuietPayInit): QuietPayClient
```

Every option is optional because a missing `baseUrl`, `apiKey`, `merchantId`, `webhookSecret`, `webhookUrl` or `billing` is read from `QUIETPAY_BASE_URL`, `QUIETPAY_API_KEY`, `QUIETPAY_MERCHANT_ID`, `QUIETPAY_WEBHOOK_SECRET`, `QUIETPAY_WEBHOOK_URL` and `QUIETPAY_BILLING`. An option you pass wins over the variable. Empty or blank values count as missing. `createQuietPay()` with no arguments is valid when the variables are set.

| Param (`QuietPayInit`) | Type | Required | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `string` | yes (or `QUIETPAY_BASE_URL`) | Relayer URL, must be a full URL |
| `apiKey` | `string` | yes (or `QUIETPAY_API_KEY`) | Must not be empty |
| `merchantId` | `Hex` | yes (or `QUIETPAY_MERCHANT_ID`) | 0x + 64 hex |
| `env` | `Record<string, string \| undefined>` | no | Where the variables are read from. Default `process.env` |
| `billing` | `"product" \| "one_time" \| "subscription" \| "both"` | no | Default `"one_time"`. `"product"` means `"one_time"` |
| `webhookUrl` | `string` | no | Added to every order the client creates |
| `webhookSecret` | `string` | no | Needed by `verifyWebhook` and the `handleWebhook` helpers |
| `subscriptionStore` | `SubscriptionStore` | no | Default in memory |
| `renewalExpiresInSeconds` | `number` | no | Integer 60..86400, default 86400 |
| `paymentLinkStore` | `PaymentLinkStore` | no | **New.** Default in memory |
| `linkCheckoutExpiresInSeconds` | `number` | no | **New.** Integer 60..86400, default 1800 |
| `fetch` | `typeof fetch` | no | For tests |
| `now` | `() => number` | no | Unix seconds clock, for tests |

**Throws** `QuietpayConfigError` when `baseUrl`, `apiKey` or `merchantId` is missing (one error names every missing one and its variable), for a `baseUrl` that is not a full URL, an unknown `billing`, a bad `merchantId`, or a TTL out of range.

```ts
const qp = createQuietPay({ billing: "both" }); // everything else from the QUIETPAY_* variables
```

### The client object

| Member | Signature | Notes |
| --- | --- | --- |
| `billing` | `"one_time" \| "subscription" \| "both"` | The chosen model (`"product"` is shown as `"one_time"`) |
| `supports` | `{ oneTime: boolean; subscription: boolean }` | |
| `createOrder(o)` | `(o: { amount: string; reference?: string; expiresInSeconds?: number }) => Promise<Order>` | Adds your `merchantId`, `apiKey`, `baseUrl` and `webhookUrl`. Throws `QuietpayConfigError` when billing is `"subscription"`, or when `reference` starts the `sub:<id>:<n>` or `link:<id>:<n>` form |
| `getOrder(orderId)` | `(orderId: string) => Promise<Order>` | |
| `listOrders()` | `() => Promise<Order[]>` | |
| `verifyWebhook(raw)` | `(raw: { body: string; signatureHeader: string; toleranceSeconds?: number; nowSeconds?: number; isDuplicate?: (id: string) => boolean }) => WebhookEvent` | Uses `webhookSecret`. Throws `QuietpayConfigError` if it is missing |
| `subscriptions` | object | Always present. Each method throws `QuietpayConfigError` unless billing includes subscriptions |
| `links` | object | **New.** Always present. Methods (except `handleWebhook`) throw `QuietpayConfigError` unless billing includes one-time payments |

### client.subscriptions

Pay-per-period subscriptions. Background: [Subscriptions](README.md#7-subscriptions).

| Method | Signature | Notes |
| --- | --- | --- |
| `createPlan` | `(p: { id?: string; name: string; amount: string; interval: Interval; intervalCount?: number }) => Promise<Plan>` | `id` 1-64 of `A-Za-z0-9_.:-` (random if omitted). `name` 1-80 chars. `amount` positive integer string. `intervalCount` 1..36 (default 1). Throws `QuietpayConfigError` if the plan id exists |
| `listPlans` | `() => Promise<Plan[]>` | |
| `subscribe` | `(s: { planId: string; customer: string; id?: string }) => Promise<Subscription>` | `customer` 1-120 chars (any id you use). First renewal is due now. Throws on unknown plan or duplicate id |
| `get` | `(id: string) => Promise<Subscription \| undefined>` | |
| `list` | `() => Promise<Subscription[]>` | |
| `due` | `(at?: number) => Promise<Subscription[]>` | Not cancelled, `nextChargeAt <= at`, and no live open order. `at` defaults to now |
| `sweep` | `(at?: number) => Promise<Subscription[]>` | Re-reads unpaid orders of overdue subscriptions: credits settled ones, marks the rest `past_due`. Returns the subscriptions it looked at |
| `createRenewalOrder` | `(id: string) => Promise<{ subscription: Subscription; order: Order }>` | Creates, or returns the open, renewal order. Reference `sub:<id>:<period>`. Throws if cancelled, not due, unknown, or 20 unpaid orders exist |
| `applyWebhook` | `(event: WebhookEvent) => Promise<Subscription \| undefined>` | Feed a **verified** event. Returns the changed subscription |
| `handleWebhook` | `(raw: { body; signatureHeader; toleranceSeconds?; nowSeconds?; isDuplicate? }) => Promise<{ event: WebhookEvent; subscription: Subscription \| undefined }>` | Verify and apply. Needs `webhookSecret` |
| `cancel` | `(id: string) => Promise<Subscription>` | Stops future renewals |

```ts
const plan = await qp.subscriptions.createPlan({ name: "Pro", amount: "5000000", interval: "month" });
const sub = await qp.subscriptions.subscribe({ planId: plan.id, customer: "cust_42" });
const { order } = await qp.subscriptions.createRenewalOrder(sub.id);
```

### client.links (New)

Payment links. Background: [Payment links](README.md#6-payment-links-new). Require billing `"product"`, `"one_time"` or `"both"`.

| Method | Signature | Notes |
| --- | --- | --- |
| `create` | `(p: { title: string; amount: string; description?: string; singleUse?: boolean; expiresInSeconds?: number; id?: string }) => Promise<PaymentLink>` | `title` 1-80 chars. `amount` positive integer string. `description` up to 280 chars. `singleUse` default `true`. `expiresInSeconds` integer 60 s to 90 days. `id` 1-64 of `A-Za-z0-9_.:-` (random `link_...` if omitted). Throws `QuietpayConfigError` on bad input or duplicate id |
| `get` | `(id: string) => Promise<PaymentLink \| undefined>` | |
| `list` | `() => Promise<PaymentLink[]>` | Newest first |
| `deactivate` | `(id: string) => Promise<PaymentLink>` | Stops new checkouts. Orders already issued can still be paid and still count. Throws on unknown id |
| `checkout` | `(id: string) => Promise<{ link: PaymentLink; order: Order }>` | Creates a checkout order for the link amount (lifetime `linkCheckoutExpiresInSeconds`). Reference `link:<id>:<n>`. Throws if the link is unknown, deactivated, expired, or single-use and already paid |
| `applyWebhook` | `(event: WebhookEvent) => Promise<PaymentLink \| undefined>` | Feed a **verified** event. Counts a `payment.settled` for an order issued for the link with the exact link amount and your merchant id. A second payment on a paid single-use link is recorded in `duplicatePayments` instead (refund it). Repeats are ignored |
| `handleWebhook` | `(raw: { body; signatureHeader; toleranceSeconds?; nowSeconds?; isDuplicate? }) => Promise<{ event: WebhookEvent; subscription: Subscription \| undefined; link: PaymentLink \| undefined }>` | Verify, then apply to subscriptions (if billing includes them) and links (if it includes one-time). Needs `webhookSecret`. There is no `client.handleWebhook` |

```ts
const link = await qp.links.create({ title: "Deposit", amount: "50000000", expiresInSeconds: 7 * 86400 });
const { order } = await qp.links.checkout(link.id);
const { event, link: changed } = await qp.links.handleWebhook({ body: rawBody, signatureHeader });
```

---

## Stores

### memorySubscriptionStore

```ts
function memorySubscriptionStore(): SubscriptionStore
```

An in-memory store. It is the default. Data is lost on restart. Use it for tests and prototypes.

### memoryPaymentLinkStore

```ts
function memoryPaymentLinkStore(): PaymentLinkStore
```

Same idea for payment links.

### SubscriptionStore

Implement this interface to keep data in your database. Every method may return a value or a Promise.

| Method | Signature |
| --- | --- |
| `getPlan` | `(id: string) => Plan \| undefined` |
| `putPlan` | `(plan: Plan) => void` |
| `listPlans` | `() => Plan[]` |
| `getSubscription` | `(id: string) => Subscription \| undefined` |
| `putSubscription` | `(sub: Subscription) => void` |
| `listSubscriptions` | `() => Subscription[]` |
| `compareAndSetSubscription` (optional) | `(prev: Subscription, next: Subscription) => boolean` |

`compareAndSetSubscription` must store `next` only if the stored row still equals `prev` (compare every field, or a version column) and return `false` otherwise. The SDK then retries (up to 5 times). **Required** when more than one process shares the database.

### PaymentLinkStore

| Method | Signature |
| --- | --- |
| `getLink` | `(id: string) => PaymentLink \| undefined` |
| `putLink` | `(link: PaymentLink) => void` |
| `listLinks` | `() => PaymentLink[]` |
| `compareAndSetLink` (optional) | `(prev: PaymentLink, next: PaymentLink) => boolean` |

Same rules as above. Each method may be sync or async.

---

## Error classes

### QuietpayApiError

```ts
class QuietpayApiError extends Error {
  readonly status: number;                 // HTTP status
  readonly code: ErrorCode | "unknown";
}
```

`ErrorCode` is one of: `order_not_found`, `order_expired`, `bad_signature`, `amount_mismatch`, `already_settled`, `relayer_paused`, `rate_limited`, `simulation_failed`, `fee_over_cap`, `insufficient_refund_balance`, `payment_replayed`, `budget_exceeded`, `invalid_amount`. What to do for each: [Errors](README.md#11-errors).

### QuietpayConfigError

Bad configuration or a usage the SDK refuses (billing model off, unknown id, cancelled subscription, deactivated link). Extends `Error`.

### WebhookVerificationError

Thrown by `verifyWebhook` and the `handleWebhook` helpers. Extends `Error`.

---

## Constants

| Name | Value | Notes |
| --- | --- | --- |
| `WEBHOOK_SIGNATURE_HEADER` | `"Quietpay-Signature"` | Header that carries `t=<unix>,v1=<hmac>` |

---

## Types

### Order

Exported as a type. Returned by `createOrder`, `getOrder`, `listOrders`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | 0x + 64 hex. Hand this to the widget |
| `merchantId` | `string` | |
| `amount` | `string` | Base units |
| `status` | `"created" \| "pending" \| "settled" \| "failed" \| "expired" \| "partially_refunded" \| "refunded"` | |
| `reference` | `string?` | Yours |
| `payout` | `string` | Address that receives `amount - fee` |
| `fee` | `string` | Relay fee, base units |
| `payer` | `string?` | |
| `txHash` | `string?` | The payment transaction |
| `failureCode` | `string?` | |
| `createdAt`, `expiresAt` | `number` | Unix seconds |
| `settledAt` | `number?` | |
| `refundedAmount`, `refunded` | `string?` | Total refunded so far, base units. Absent means zero |
| `refundCount` | `number?` | |
| `gasWei` | `string?` | Merchant list only |
| `explorerUrl` | `string?` | `http(s)` link to the transaction |
| `checkout` | `{ chainId, token, router, value, nonce, payout, fee, domain: { name, version } }` | What the payer signs. Always consistent with `amount`, `fee`, `payout` |

### WebhookEvent

| Field | Type |
| --- | --- |
| `id` | `string` |
| `type` | `"payment.settled" \| "payment.failed" \| "payment.refunded"` |
| `createdAt` | `number` |
| `data` | `{ orderId, merchantId, amount, fee, payer?, payout, txHash?, reference?, failureCode?, refundId?, refundAmount?, totalRefunded?, refundIndex? }` |

### RefundContext

`{ orderId, merchantId, payer, refundSigner, amountPaid, refunded, refundIndex, refundBalance, chainId, token, router, domain: { name, version } }`. `refundBalance` is the USDT held by the refund-signer wallet.

### Refund (type)

`{ id, orderId, amount, refundIndex, status: "pending" | "settled" | "failed", txHash?, failureCode?, createdAt }`.

### Plan

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | |
| `name` | `string` | |
| `amount` | `string` | Base units per period |
| `interval` | `Interval` | |
| `intervalCount` | `number` | |
| `createdAt` | `number` | |

### Subscription

| Field | Type | Notes |
| --- | --- | --- |
| `id`, `planId`, `customer` | `string` | |
| `status` | `SubscriptionStatus` | `"active" \| "past_due" \| "cancelled"` |
| `paidPeriods` | `number` | |
| `nextChargeAt` | `number` | Unix seconds |
| `pendingOrderId`, `pendingExpiresAt` | `Hex?`, `number?` | The open renewal order |
| `periodOrders` | `Hex[]?` | Renewal orders issued for the current unpaid period (max 20). Any of them can credit the period, once |
| `paidOrderIds` | `Hex[]?` | Orders that paid a period (last 50) |
| `closedOrders` | `Hex[]?` | Unpaid orders of periods already paid (last 50) |
| `duplicatePayments` | `{ orderId, amount, at }[]?` | Double payments. Refund these |
| `anchorAt` | `number?` | First due date; all later dates are this plus whole periods |
| `lastPaidOrderId`, `lastPaidAt` | `Hex?`, `number?` | |
| `createdAt`, `cancelledAt` | `number`, `number?` | |

### PaymentLink

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | |
| `title` | `string` | 1-80 characters |
| `description` | `string?` | Up to 280 characters |
| `amount` | `string` | Base units |
| `singleUse` | `boolean` | |
| `status` | `PaymentLinkStatus` | `"active" \| "paid" \| "deactivated"` |
| `paidCount` | `number` | Verified payments credited |
| `expiresAt` | `number?` | Checkout is refused from this time on |
| `createdAt` | `number` | |
| `orderIds` | `string[]` | Checkout orders issued (last 50). Only these can credit the link |
| `paidOrderIds` | `string[]` | Credited orders (last 50) |
| `lastPaidOrderId`, `lastPaidAt` | `string?`, `number?` | |
| `duplicatePayments` | `string[]?` | Orders that settled after a single-use link was already paid. Refund these |

### Other exported types

| Type | Definition |
| --- | --- |
| `BillingMode` | `"one_time" \| "subscription" \| "both"` |
| `BillingOption` | `BillingMode \| "product"` |
| `Interval` | `"day" \| "week" \| "month" \| "year"` |
| `SubscriptionStatus` | `"active" \| "past_due" \| "cancelled"` |
| `PaymentLinkStatus` | `"active" \| "paid" \| "deactivated"` |
| `QuietPayInit`, `QuietPayConfig`, `QuietPayClient` | What `createQuietPay` accepts (all optional, env fallback), the resolved config, and the return type |
| `CreateOrderOptions`, `GetOrderOptions`, `VerifyWebhookOptions`, `RefundOptions`, `PaywallOptions` | The option objects above |
| `SubscriptionStore`, `PaymentLinkStore` | Store interfaces |
| `Order`, `WebhookEvent`, `Refund`, `RefundContext` | Described above (types only) |

### What is not exported

The SDK does not export `parseUsdt`, `formatUsdt`, `signWebhook`, or the shared zod schemas. `@quietpay/shared` is a private workspace package that is bundled inside the SDK. Inside the monorepo you can import `parseUsdt` and `formatUsdt` from `@quietpay/shared`. Outside it, use the small helper in the [guide](README.md#step-1-create-an-order-on-your-server).
