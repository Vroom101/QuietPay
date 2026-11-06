# Handoff for A and B

`contracts/` and `packages/shared` belong to Lead. Do not edit them on your branch; ask here. Never hand-edit
`pnpm-lock.yaml`. The ABI is generated from the Foundry build, never copied.

**Tags:** `shared-v2` (fee in the pay nonce, strict amounts), `qualifying-v1` (live payment and refund on the qualifying router).
**Current router:** `0xb9D475cdd817900B45C356169c6FdC379B942d82`, deploy block 12351795, official USDT
`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, chain 1874. In code use `getQualifyingDeployment()`; never hard-code it.

Steps for both: `git merge main`, make the changes for your folder, `pnpm install`, `pnpm -r typecheck`, `pnpm -r test`.

A read-only grep of `apps/`, `packages/widget`, `packages/relayer`, `packages/merchant-sdk` on 2026-11-06 found no
`DemoUSDT`, no old router `0x6a76...` and no stand-in token `0x02Dd...` in code.

## B (relayer, SDK): `feat/backend`

- [x] `computePayNonce` is called with `fee` (service.ts), and `pay(...)` submits exactly `order.fee`.
- [x] Stand-in token case removed from `packages/relayer/test/e2e-anvil.test.ts`.
- [ ] Call `assertQualifyingConfig({ chainId, tokenAddress })` at startup on chain 1874.
- [ ] Refund API: `GET /v1/orders/:id/refund-quote` and `POST /v1/refund`. Schemas and mock are in shared
      (`POST /v1/relay/refund` in the mock). The relayer must accept a refund authorization signed by the merchant's
      refund signer over `computeRefundNonce(merchantId, orderId, payer, amount, refundIndex)`, call `refund(...)`, and
      return the tx hash. Map: seven-decimal or malformed amount -> `invalid_amount`; signer short of USDT ->
      `insufficient_refund_balance`; hourly gas loss budget -> `budget_exceeded`.
- [ ] **x402 front-running (when x402 is built).** If someone submits the agent's authorization first, the facilitator's
      own transaction reverts even though the money arrived. Before reporting failure, read the token's
      `authorizationState(authorizer, nonce)` and look for the `Transfer` log for that nonce; if the transfer happened,
      treat the payment as settled. Add a test that front-runs the authorization on anvil.
- [ ] Reject all-zero `orderId` and `merchantId` in `createOrder` (the router accepts them; see decisions.md, router review R1/R3).
- [ ] Upgrade `fastify` (high advisories, fix >= 5.12.2) and re-run the relayer suites; see blocked.md, dependency audit.
- [ ] Reconcile only against the qualifying router. Orders created for any older router cannot be paid.

## A (widget, store, dashboard): `feat/frontend`

- [x] Dashboard test uses the exact six-decimal format (`25.000000`).
- [x] Demo store answers 400 `invalid_amount` for a malformed cart total.
- [ ] **Net amount can be negative.** `net_usdt` is `value - fee - refunded` and is `-0.050000` after a full refund (the
      relay fee is not returned). If the dashboard shows net, render the leading minus and do not clamp. Decision and
      reason: `decisions.md`, "Net amount meaning".
- [ ] Show exact `formatUsdt` wherever the payer's signed amount or fee is displayed; use `formatUsdtShort` only where
      the exact value is also visible.
- [ ] Read the router from `order.checkout.router`; no hard-coded address.
- [ ] Refund button: waits for B's refund API. It should call the SDK `refund` helper and show `insufficient_refund_balance`
      as "the refund signer wallet needs more USDT".
- [ ] Run one real browser checkout against the deployed router with the official USDT and keep the tx link for the demo.

## What changed in `@quietpay/shared` (v2), for reference

`PAY_TAG = keccak256("quietpay.pay.v2")`; `computePayNonce({merchantId, orderId, payout, value, fee})` requires `fee`;
`computeRefundNonce` unchanged; `parseUsdt` is strict (plain decimal, at most 6 places, no rounding, throws
`InvalidAmountError`); `formatUsdt` is exact (6 places); `formatUsdtShort` is lossy and display-only; error codes
`invalid_amount` and `budget_exceeded` added; `checkFundPlan` guards `scripts/fund-payer.ts`.
