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

Events on the element: `quietpay:settled` (detail `{order}`) and `quietpay:error` (detail `{code, message}`). The React wrapper exposes them as `onSettled` and `onError`. Workspace consumers import the TypeScript sources directly, so no build is needed in this monorepo.

## apps/demo-store

Shop UI (Vite, port 5173) plus a Fastify API (port 3001) that uses the merchant SDK.

```
pnpm --filter @quietpay/shared mock                     # terminal 1
pnpm --filter @quietpay/demo-store dev                  # terminal 2: web + api
pnpm --filter @quietpay/demo-store simulate-webhook <orderId>   # optional: fake the relayer webhook
pnpm --filter @quietpay/demo-store test
```

Copy `apps/demo-store/.env.example` to `.env` to override `QUIETPAY_BASE_URL`, `QUIETPAY_API_KEY`, `QUIETPAY_MERCHANT_ID`, `QUIETPAY_WEBHOOK_SECRET`. Defaults suit the mock relayer. Node 22.9 or newer is needed for `--env-file-if-exists`. The mock relayer never sends webhooks, so the success page keeps saying "confirming" until you run `simulate-webhook`.

SDK: `@quietpay/merchant-sdk` was not in this worktree, so `server/sdk-stub.ts` implements the frozen interface. To switch, change the one import line in `server/index.ts`.

### Connect the store to the hosted relayer

Set `VITE_RELAYER_URL` and `QUIETPAY_BASE_URL` in `apps/demo-store/.env` to the hosted relayer URL. Set `VITE_CHECKOUT_ROUTER` to the deployed router unless the address is already in the shared deployment file. For DemoUSDT, set `VITE_CHECKOUT_TOKEN` to its deployed address, `VITE_CHECKOUT_DOMAIN_NAME="Quietpay Demo USDT"`, and `VITE_CHECKOUT_DOMAIN_VERSION=1`. Get these values from the deployment handoff. Restart the Vite server after changing them.

Set `QUIETPAY_API_KEY` and `QUIETPAY_MERCHANT_ID` for the registered merchant. Set `QUIETPAY_WEBHOOK_URL` to the publicly reachable store endpoint ending in `/webhooks/quietpay`, and use the same `QUIETPAY_WEBHOOK_SECRET` as the relayer. Fund the payer address shown in the widget with demo tokens, complete checkout, and check that the store confirms the payment after the webhook arrives. Keep the payer's WBT balance at zero for this run.

## apps/merchant-dashboard

```
VITE_USE_FIXTURES=1 pnpm --filter @quietpay/merchant-dashboard dev    # sample data, port 5174
pnpm --filter @quietpay/merchant-dashboard dev                        # real relayer: VITE_RELAYER_URL, type API key in page
pnpm --filter @quietpay/merchant-dashboard test
```

On Windows Git Bash `VITE_USE_FIXTURES=1 pnpm ...` works; in PowerShell set `$env:VITE_USE_FIXTURES=1` first. The API key is typed into the page and kept in `sessionStorage` only. There is no refund control (P1).
