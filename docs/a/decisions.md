# Decisions (owner A)

1. **Widget package exports TS sources** (`main`/`exports` point at `src/`), like `@quietpay/shared`, so the demo store needs no widget build. `vite build` still produces `dist/` for external use.
2. **Order is fetched on load and again on Pay.** Load shows amount and address early; the second fetch makes sure the signed value matches what the relayer holds now, and handles an order that became pending/settled in another tab.
3. **Signing window:** validAfter = now-5s, validBefore = now+300s (305s total, under the 600s router limit).
4. **Error mapping:** relayer codes map through `ERROR_USER_MESSAGES`. Extra widget-only messages (network, timeout, unknown code) are written in plain words with no mention of gas, WBT or transactions. The on-screen "Receipt" is the tx hash, labelled as a receipt.
5. **Failed/expired orders** show the message for `failureCode` (or `order_expired`).
6. **Merchant SDK stub:** `apps/demo-store/server/sdk-stub.ts` follows the frozen interface and wraps shared webhook helpers. `amount` is passed in token base units (matches `CreateOrderRequest`).
7. **Webhook route** parses JSON as a string in an encapsulated Fastify plugin so the raw body is verified byte for byte.
8. **Dashboard API key** is typed into the page and stored in `sessionStorage`, not in env, so no secret lands in a Vite bundle.
9. **Pinned older majors:** Tailwind 3 and Fastify 4 for stable tooling on Windows.

## Shared changes wanted (not made; worked around)
- Add an optional merchant display name to `Order` (widget currently shows the shortened merchant id).
- Mock relayer: serve `GET /v1/orders` and send signed webhooks, so the dashboard and store need no fixtures or simulator.
- Mock relayer: verify the relay signature with `recoverCheckoutSigner` to catch widget regressions end to end.
