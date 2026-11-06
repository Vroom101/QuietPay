# Frontend (Person A) integration, 2026-11-07

Merged `origin/feat/frontend` (12 commits, author Naman; 165 behind main) into `main` via branch `integration/frontend`.

Resolution rules
- Lead and backend folders: `main` wins (contracts, packages/shared, packages/relayer, docs/lead). The old `DemoUSDT.sol` and its tests from A's branch were NOT brought back.
- `packages/widget`: `main`'s hardened widget (verify-before-sign, keystore protections, pinned order). A's two widget commits were a "DemoUSDT checkout setting" and a weaker verify-before-sign, both superseded.
- `apps/demo-store/server`: `main`'s server (prices the cart from the server catalog, issues the customer status token, official USDT only, body and timeout limits). A's server priced from a browser-sent `cartTotal` and added a simulated "demo stablecoin" payment route plus demo billing/invoices.
- `apps/demo-store/src`: A's redesigned UI. `pages/Checkout.tsx` was adapted to the secure flow: send item ids only, parse the server's session, pin `expectedAmount` and `expectedPayout` for the widget, keep the customer status token (new `src/order-token.ts`, sessionStorage) and send it on `/api/orders/:id/paid` (`src/payment.ts`).
- `apps/merchant-dashboard`: A's UI and richer sample orders; `lib/api.ts` is `main`'s (keeps the direct-relayer path and the access-token guard) with A's `fixtureOrders`; 401/403 from the merchant server now say "The dashboard access token was not accepted."

Not integrated (for Person A, see `needs-from-others.md`)
- The simulated "demo stablecoin" route, demo quotes/confirm, billing and invoices (server `demo-billing.ts` is present but unregistered; `src/pages/Billing.tsx` and `src/billing.ts` still exist and will not work until A re-adds demo mode on top of the hardened server). Their test was set aside as `apps/demo-store/test/_deferred-demo-mode/demo-mode.test.ts.txt`.
- `onRefunded` on the widget (the hardened widget has no such prop).
