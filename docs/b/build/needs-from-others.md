# Needs from other streams / UI

## w5 (demo-store UI, owned by someone else; no src edits were made)
1. apps/demo-store/src (checkout page): read the `Quietpay-Order-Token` RESPONSE HEADER of POST /api/checkout and keep it in memory or sessionStorage (never in a URL). The JSON body is unchanged.
2. Anything that polls GET /api/orders/:id/paid for a new order must send `Quietpay-Order-Token: <token>`; without it the answer is `{"paid":false}` forever.
3. A refund-status panel can call GET /api/orders/:id/refund-status with the same header (200 body is the CustomerRefundStatus schema; 404 {"error":"not_found"}; 429 rate_limited). Do not put the token in the query string (400).
4. The token is shown once; if a customer loses it there is no recovery path yet (order_access.rotated_at is reserved for a future rotate endpoint).

## Person A, after the frontend merge (2026-11-07)
1. Billing, invoices, payment links and the simulated "demo stablecoin" route are not wired: the hardened server has no `/api/checkout/demo-quote`, `/demo-confirm` or billing routes. If you want them, re-add them on top of `apps/demo-store/server/app.ts` behind a flag, keep them off by default, and label every screen as a simulation. Restore `test/_deferred-demo-mode/demo-mode.test.ts.txt` when you do.
2. The checkout page now needs the live widget flow only. Review `src/pages/Checkout.tsx` and `src/pages/Success.tsx` (status polling sends the customer token).
3. Run the store with `QUIETPAY_STATE_FILE`, `QUIETPAY_RECEIPT_DATABASE_PATH` and a real relayer; there is no mock-relayer mode in the integrated server.
