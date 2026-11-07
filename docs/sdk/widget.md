# Checkout widget (`@quietpay/widget`)

The widget is the part your customer sees: the price, a **Pay with MetaMask** button, and a result. It runs in the browser. It needs no API key.

Back to the [developer guide](README.md). Server functions are in the [API reference](api-reference.md).

> The widget is not published to npm. See [Install](#install).

## What it does

1. Loads the order from the relayer (`GET /v1/orders/<id>`) and shows the price.
2. Checks the order against what **you** told it to expect (amount, payout, chain, token, router). If anything is off, it refuses to sign.
3. Asks the wallet for **one** signature (EIP-3009, `eth_signTypedData_v4`). No transaction, no gas.
4. Sends the signature to the relayer, which pays the gas and submits the payment.
5. Polls the order until it is settled, failed or expired (up to 60 seconds), and shows the result.

## Install

Not on npm. Two ways:

**In the monorepo (Vite, React or plain TS).** Add the workspace dependency and run `pnpm install`:

```json
{ "dependencies": { "@quietpay/widget": "workspace:*" } }
```

It has two entry points: `@quietpay/widget` (the web component) and `@quietpay/widget/react` (the React wrapper). The package points at its TypeScript source, so your bundler compiles it. It ships no `.d.ts` files.

**Outside the monorepo.** Build it, then copy the output to your site:

```sh
pnpm --filter @quietpay/widget build     # ES modules in packages/widget/dist
```

Load `index.js` with `<script type="module">`. The React wrapper (`react.js`) needs React 18 or newer as a peer dependency (it is optional otherwise). The widget depends on `lit` and `viem`, which are bundled into the build.

## React

```tsx
import { QuietpayCheckout } from "@quietpay/widget/react";

<QuietpayCheckout
  orderId={session.orderId}
  relayerUrl="http://127.0.0.1:8790"
  expectedAmount={session.amount}
  expectedPayout={session.payout}
  onSettled={(order) => console.log("paid", order.id)}
  onError={({ code, message }) => console.warn(code, message)}
/>
```

### Props

| Prop | Type | Required | Notes |
| --- | --- | --- | --- |
| `orderId` | `string` | yes | `Order.id` from your server (0x + 64 hex) |
| `relayerUrl` | `string` | yes | Base URL of the relayer. Must be reachable from the browser (the relayer needs your page's origin in its `CORS_ORIGINS`) |
| `expectedAmount` | `string` | strongly recommended | The price as a **decimal USDT string**, `"25"` or `"25.5"` or `"25.000000"` (up to 6 decimals). The widget refuses to sign an order with any other amount. If you omit it, the amount is not checked against your price |
| `expectedPayout` | `string` | strongly recommended | Your payout address. The widget refuses to sign if the order pays anyone else |
| `onSettled` | `(order: Order) => void` | no | Called when the order is paid. **Not proof of payment.** Wait for your webhook |
| `onError` | `(err: { code: string; message: string }) => void` | no | Called when something stops the payment. `message` is plain English for the customer |
| `chainId` | `number` | no | Local test chains only. Default 1874 |
| `token` | `string` | no | Local test chains only. Default the official USDT |
| `router` | `string` | no | Local test chains only. Default the deployed router. **Required** if you change `chainId` |
| `domainName` | `string` | no | Local test chains only. Default `Tether USD` |
| `domainVersion` | `string` | no | Local test chains only. Default `1` |

Do not set the last five for the real testnet. They exist so the widget can be tested against a local chain. They must come from your page, never from the relayer.

## Plain HTML (web component)

```html
<script type="module" src="/quietpay/index.js"></script>

<quietpay-checkout
  id="pay"
  order-id="0x..."
  relayer-url="http://127.0.0.1:8790"
  expected-amount="25.000000"
  expected-payout="0xYourPayoutAddress"
></quietpay-checkout>
```

The script registers the element `quietpay-checkout`.

### Attributes

| Attribute | Same as prop |
| --- | --- |
| `order-id` | `orderId` |
| `relayer-url` | `relayerUrl` |
| `expected-amount` | `expectedAmount` |
| `expected-payout` | `expectedPayout` |
| `chain-id` | `chainId` |
| `token` | `token` |
| `router` | `router` |
| `domain-name` | `domainName` |
| `domain-version` | `domainVersion` |

Changing `order-id` or `relayer-url` after the first render reloads the order. You can also set the camel-case properties from JavaScript: `el.orderId = "0x..."`.

### Events

Both bubble and cross shadow DOM.

| Event | `event.detail` | When |
| --- | --- | --- |
| `quietpay:settled` | `{ order }` (an `Order`) | The order is `settled`, `partially_refunded` or `refunded`. It also fires on load for an order that is already paid |
| `quietpay:error` | `{ code, message }` | Anything that stops the flow |

```js
const el = document.querySelector("quietpay-checkout");
el.addEventListener("quietpay:settled", (e) => location.assign(`/success/${e.detail.order.id}`));
el.addEventListener("quietpay:error", (e) => console.warn(e.detail.code, e.detail.message));
```

## The MetaMask flow

When the customer clicks **Pay ... USDT with MetaMask**:

1. **Connect.** The widget calls `eth_requestAccounts` and takes the first account.
2. **Network.** It asks MetaMask to switch to Whitechain Sepolia (chain 1874). If MetaMask does not know the network, the widget adds it (RPC `https://rpc.ankr.com/whitechain_testnet`, coin WBT, explorer `https://explorer.testnet.whitechain.io`) and then switches. The customer only clicks Approve.
3. **Balance check.** It reads the customer's USDT balance. If it is lower than the price, it stops with exact numbers, before asking for a signature. If the balance cannot be read, it carries on (the relayer checks again).
4. **Check the order.** Before MetaMask is asked to sign, the widget checks the chain, token, router, token domain, amount, fee, payout and the nonce (which it re-computes itself). It also checks the order is the same one it first showed on screen. Any mismatch stops here and nothing is signed.
5. **Sign.** MetaMask shows one typed-data message. The signature is valid for at most 300 seconds. The widget verifies that the signature really comes from the connected account.
6. **Send and wait.** The relayer pays the gas. The widget shows "Confirming your payment..." until the order is final.

Gas is never paid by the customer. The customer needs **test USDT** and nothing else.

### The demo wallet button

The widget also shows **Pay with demo wallet** (the main button if MetaMask is not installed). It creates a random key, encrypted and kept in the browser's IndexedDB, and shows its address. The customer must send test USDT to that address first. It is **demo-grade**: clearing site data loses the key and the funds, and a script running on your origin could use it. The widget footer says so. There is no option to hide this button. Do not present it to real customers.

## Errors a customer can see

The error box shows plain words. `err.code` is what you get in `onError`.

**From the relayer** (same codes as `QuietpayApiError`):

| `code` | Message the customer sees |
| --- | --- |
| `order_not_found` | We could not find this order. Please go back to the store and start again. |
| `order_expired` | This payment link has expired. Please go back to the store and start again. |
| `bad_signature` | We could not confirm your approval. Please try again. |
| `amount_mismatch` | The amount changed since you started. Please go back and check the price. |
| `already_settled` | This order has already been paid. You have not been charged twice. |
| `relayer_paused` | Payments are paused for a moment. Please try again shortly. |
| `rate_limited` | Too many attempts. Please wait a minute and try again. |
| `simulation_failed` | This payment could not go through, and you have not been charged. Please check your balance and try again. |
| `fee_over_cap` | This payment could not be processed right now, and you have not been charged. Please try again later. |
| `payment_replayed` | This approval was already used. Please start a new payment. |
| `budget_exceeded` | Payments are paused briefly while we catch up. Please try again later. |
| `invalid_amount` | That amount is not valid. Use a number with up to 6 decimal places. |

**Refusals by the widget itself.** Nothing was signed and no money moved. The customer sees: "We stopped this payment because its details did not match this shop's checkout. Nothing was signed and no money moved. Please contact the shop." These mean your setup is wrong or the relayer is not the one you think it is:

| `code` | Cause |
| --- | --- |
| `checkout_amount_mismatch` | The order amount is not your `expectedAmount` |
| `checkout_payout_mismatch` | The order pays an address other than `expectedPayout` |
| `checkout_chain_mismatch`, `checkout_token_mismatch`, `checkout_router_mismatch`, `checkout_domain_mismatch` | The order is for another chain, token, router or token domain than expected |
| `checkout_fee_mismatch`, `checkout_fee_invalid` | The fee differs between fields, or is not below the price |
| `checkout_nonce_mismatch` | The nonce is not derived from this order |
| `checkout_order_mismatch` | The relayer returned a different order, or one with no checkout |
| `checkout_display_mismatch` | The order changed between what was shown and what was about to be signed |
| `checkout_config_invalid` | `expectedAmount` or `chainId` is malformed, or a router is missing for a non-default chain |
| `checkout_window_invalid` | Internal: signature validity window out of range |

**Wallet:**

| `code` | Meaning |
| --- | --- |
| `wallet_unavailable` | No wallet found, the wallet shared no account, or a wallet call failed. The message says which step |
| `wallet_rejected` | The customer cancelled in MetaMask |
| `wallet_wrong_chain` | The wallet is not on Whitechain Sepolia |
| `wallet_account_changed` | The selected account changed during the flow. Reconnect |
| `wallet_signature_mismatch` | The wallet returned a signature that is unusable or not from the connected account. Nothing was sent |
| `wallet_insufficient_balance` | "Your wallet has X USDT but this payment needs Y USDT. Add test USDT to 0x... and try again." |
| `wallet_unreadable` | The saved demo wallet cannot be opened. It is never replaced automatically |

**Other:** `network` ("We could not reach the payment service. Please check your connection and try again."), `timeout` ("This is taking longer than expected. Please check back in a moment; you will not be charged twice.") and `unknown` ("Something went wrong on our side. Please try again in a moment.").

Except for `order_not_found`, `order_expired` and `already_settled`, the error box has a **Try again** button.

## Styling

The widget draws inside a shadow root. Your page CSS does not reach the inside, and the widget defines **no** CSS custom properties or `::part()` hooks. What you can do:

- Style the host element: it is `display: block; max-width: 24rem`. Set `width`, `max-width`, `margin`, `align-self` and so on on `quietpay-checkout` as with any element.
- Put it inside your own card, modal or page layout.
- For a different look, build your own UI with the exported functions below.

The card is white with a dark button and uses the system font.

## Lower-level exports

`@quietpay/widget` also exports the pieces the component is made of, if you want your own interface:

| Export | What it does |
| --- | --- |
| `QuietpayCheckout` | The custom element class |
| `fetchOrder(relayerUrl, orderId)` | Reads and validates an order |
| `verifyCheckout(order, expected)` | Throws `WidgetError` unless the order is safe to sign |
| `pinDisplayedOrder(order)`, `verifyDisplayedOrder(order, displayed)` | Tie what is signed to what was shown |
| `signCheckout(signer, order, now?, { expected, displayed, windowSeconds })` | Verifies, then signs the single authorization. Window at most 300 s |
| `relayPay(relayerUrl, request)` | Sends the signed request to the relayer |
| `pollOrder(relayerUrl, orderId, { intervalMs, timeoutMs, onUpdate })` | Polls until final. Defaults 1 s and 60 s |
| `connectMetaMask()`, `metamaskAvailable()`, `injectedProvider()` | Wallet helpers |
| `readUsdtBalance(...)`, `requireBalance(...)` | USDT balance checks |
| `messageForCode(code)` | Customer wording for any error code |
| `WidgetError` | Error with a `code` |
| `WHITECHAIN_SEPOLIA` | Network parameters used to add the chain |
| `getOrCreateAccount`, `exportBackup`, `importAccount`, `KeystoreError` | The browser demo wallet |

## Checklist

- Pass `expectedAmount` and `expectedPayout` from your server, never from the order you just fetched in the browser.
- Do not fulfil on `onSettled`. Fulfil from your [webhook](README.md#step-3-handle-the-webhook).
- Add your page's origin to the relayer's allowed CORS origins.
- Use a wallet with test USDT. It does not need WBT.

Working example: [`apps/demo-store/src/pages/Checkout.tsx`](../../apps/demo-store/src/pages/Checkout.tsx).
