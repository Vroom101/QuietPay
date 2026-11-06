# Owner A: widget, demo store, merchant dashboard

All commands run from the repo root after `pnpm install`.

## Mock relayer (needed by the widget and the demo store)

```
pnpm --filter @quietpay/shared mock        # http://localhost:8787
```

Magic amounts: base units ending in `0001` make the relay fail with `simulation_failed`, ending in `0002` with `rate_limited`. Order `0xabab...ab` is already settled.

## packages/widget

`<quietpay-checkout order-id="0x..." relayer-url="http://localhost:8787">` (Lit custom element) and the React wrapper `QuietpayCheckout` from `@quietpay/widget/react`.

```
pnpm --filter @quietpay/widget test        # vitest: key storage, signing, error codes, full flow
pnpm --filter @quietpay/widget typecheck
pnpm --filter @quietpay/widget build       # Vite library build into packages/widget/dist
```

The React wrapper exposes `onSettled`, `onRefunded`, and `onError`. A partially or fully refunded order opens as a receipt. Workspace consumers import the TypeScript sources directly.

## apps/demo-store

Shop UI (Vite, port 5173) plus a Fastify API (port 3001) that uses the merchant SDK.

```
pnpm --filter @quietpay/shared mock                     # terminal 1
pnpm --filter @quietpay/demo-store dev                  # terminal 2: web + api
pnpm --filter @quietpay/demo-store test
```

Copy `apps/demo-store/.env.example` to `.env`. Set `QUIETPAY_MOCK_RELAYER=1` when using the fixture relayer. Set `QUIETPAY_ENABLE_DEMO_CONVERSION=1` to expose the simulated conversion and billing screens in that mode. The store simulates signed webhook delivery for its own fixture orders. Leave both flags unset for a real relayer, including one running on port 8787. Node 22.9 or newer is needed for `--env-file-if-exists`.

SDK: the server uses the real `@quietpay/merchant-sdk`. `server/sdk-stub.ts` remains only as a historical test helper.

### Connect the store to the hosted relayer

Set `VITE_RELAYER_URL` and `QUIETPAY_BASE_URL` in `apps/demo-store/.env` to the hosted relayer URL. Set `VITE_CHECKOUT_ROUTER` to the deployed router unless the address is already in the shared deployment file. For DemoUSDT, set `VITE_CHECKOUT_TOKEN` to its deployed address, `VITE_CHECKOUT_DOMAIN_NAME="Quietpay Demo USDT"`, and `VITE_CHECKOUT_DOMAIN_VERSION=1`. Get these values from the deployment handoff. Restart the Vite server after changing them.

Set `QUIETPAY_API_KEY` and `QUIETPAY_MERCHANT_ID` for the registered merchant. Set `QUIETPAY_WEBHOOK_URL` to the publicly reachable store endpoint ending in `/webhooks/quietpay`, and use the same `QUIETPAY_WEBHOOK_SECRET` as the relayer. Fund the payer address shown in the widget with demo tokens, complete checkout, and check that the store confirms the payment after the webhook arrives. Keep the payer's WBT balance at zero for this run.

## apps/merchant-dashboard

```
VITE_USE_FIXTURES=1 pnpm --filter @quietpay/merchant-dashboard dev    # sample data, port 5174
pnpm --filter @quietpay/merchant-dashboard dev                        # merchant server: VITE_MERCHANT_API_URL, enter dashboard access token
pnpm --filter @quietpay/merchant-dashboard test
```

On Windows Git Bash `VITE_USE_FIXTURES=1 pnpm ...` works; in PowerShell set `$env:VITE_USE_FIXTURES=1` first. The separate dashboard access token is typed into the page and kept in `sessionStorage` only. The relayer API key and refund signing key stay on the merchant server. Partial/full refund controls show balance and history; see [setup and recovery](../b/dashboard-refunds.md).
