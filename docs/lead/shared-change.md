# Shared changes for A and B

`contracts/` and `packages/shared` belong to Lead. Never edit them on your branch; ask here. Never hand-edit
`pnpm-lock.yaml` (regenerate with `pnpm install`). The ABI is generated from the Foundry build, never copied.

**Current tag: `shared-v2`.** Steps for everyone: (1) `git merge main`, (2) make the changes below for your folder,
(3) `pnpm install`, `pnpm -r typecheck`, `pnpm -r test`.

Until you do, `main` is red in your packages: the relayer does not compile and one dashboard test fails. That is
expected and is listed under "Broken on main right now".

## What changed in `@quietpay/shared` (v2)

| Item | Change |
| --- | --- |
| `PAY_TAG` | now `keccak256("quietpay.pay.v2")` |
| `computePayNonce({merchantId, orderId, payout, value, fee})` | **`fee` is required** (bigint). It is part of the nonce, so the payer signs the exact fee quoted |
| `computeRefundNonce` | unchanged |
| `parseUsdt(str, decimals?)` | **strict**: plain decimal only, at most `decimals` places (6 for the test USDT), no rounding, rejects zero, caps at 1,000,000,000. Throws `InvalidAmountError` (`.code === "invalid_amount"`) |
| `parseUsdtAllowZero` | same rules, accepts zero (use for a fee) |
| `formatUsdt(base)` | **exact**: always 6 decimals, `"25.000000"` (was `"25.00"`) |
| `formatUsdtShort(base, places = 2)` | new, **lossy, display only** (truncates). Never sign, store, export or compare with it |
| `Order` schema | `fee` always present and must equal `checkout.fee`; `amount` must equal `checkout.value`; payout must match |
| `assertQualifyingConfig({chainId, tokenAddress})`, `QUALIFYING_CHAIN_ID`, `QUALIFYING_USDT` | throws unless chain 1874 and the official USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` |
| Error codes | added `invalid_amount` (400) and `budget_exceeded` (503); `insufficient_refund_balance` and `payment_replayed` already existed |
| Mock relayer | a decimal amount with seven places returns `invalid_amount`; every order carries the signed `fee` |
| Router ABI | regenerated: `computeNonce(merchantId, orderId, payout, value, fee)`, `setRefundSigner`, `RefundSignerChanged`, error `TokenAmountMismatch`; `fee >= value` now reverts `FeeOverCap` |
| Vectors | `packages/shared/fixtures/nonce-vectors.json` is asserted by Foundry and by the shared tests |

## B (relayer, SDK): `feat/backend`

- [ ] `packages/relayer/src/service.ts` line about 157 (`createOrder`): `computePayNonce` now needs `fee: fee`. The fee is
      already computed just above; move that computation before the call. **Submit exactly `order.fee` to `pay(...)`.**
- [ ] Map failures to the codes: malformed amount fields to `invalid_amount` (the server error handler currently
      answers `amount_mismatch`); hourly loss budget to `budget_exceeded` (currently `relayer_paused`); a token revert
      on refund because the signer is short of USDT to `insufficient_refund_balance`.
- [ ] Call `assertQualifyingConfig({ chainId, tokenAddress })` at startup when running against chain 1874.
- [ ] Build `GET /v1/orders/:id/refund-quote` and `POST /v1/refund` (schemas and mock are in shared).
- [ ] `packages/relayer/test/e2e-anvil.test.ts`: remove the stand-in token case and its artifact path. The mock token
      artifact is now `contracts/out/MockAuthToken.sol/MockAuthToken.json` (function `mint`, domain `Tether USD` / `1`).
      Until you do, that test skips itself because its old artifact no longer exists.
- [ ] `packages/relayer/src/config.ts`: delete the comment "Set for the demo token" next to `TOKEN_DOMAIN_NAME`.
- [ ] **Point the relayer at the qualifying router** `0xb9D475cdd817900B45C356169c6FdC379B942d82` (deploy block 12351795,
      official USDT). The same values are in `contracts/deployments.json` and `.env.example`; in code use
      `getQualifyingDeployment()` from `@quietpay/shared` so the address cannot drift. Orders created for any older
      router cannot be paid.

## A (widget, store, dashboard): `feat/frontend`

- [ ] `apps/demo-store/server/app.ts` line about 37: `parseUsdt(total)` is now strict. Catch `InvalidAmountError` and
      answer 400 `{ error: { code: "invalid_amount" } }`. The cart total must be a plain decimal string with at most
      6 places: no `toFixed(7)`, no thousands separators, no currency symbol, no exponent.
- [ ] `apps/merchant-dashboard/src/lib/view.ts` lines about 21 and 22: `formatUsdt` now returns `"25.000000"`. Update the
      test in `apps/merchant-dashboard/test/dashboard.test.ts`, or use `formatUsdtShort` for compact table cells.
- [ ] `packages/widget/src/element.ts` lines about 155, 177 and 192: showing the exact `formatUsdt(amount)` is
      recommended, because it is what the payer signs. Use `formatUsdtShort` only where the exact value is also visible.
- [ ] The widget needs no nonce arithmetic: it signs `order.checkout.nonce`, which now includes the fee. Show the fee
      the order quotes.
- [ ] The widget's mock-server tests: a seven-decimal amount now returns `invalid_amount` (already in the error table).
- [ ] Point the widget and store at the same router (read it from the order's `checkout.router`; no hard-coded address needed).
- [ ] Remove any leftover reference to a demo or stand-in token in your folders (none found by search in A's code).

## Broken on main right now (by design, until A and B merge)

- `packages/relayer`: `src/service.ts` does not compile (missing `fee`), so its tests fail.
- `apps/merchant-dashboard`: `test/dashboard.test.ts` ("formats amount and fee") expects the old two-decimal format.

## Earlier changes (kept for reference)

- **Refunds (shared-change #1):** `computeRefundNonce`, `buildRefundAuthorization`, `RefundQuote*`, `RefundRequest/Response`,
  mock endpoints `GET /v1/orders/:id/refund-quote` and `POST /v1/refund`, `Order.refundedAmount`.
- **Pay nonce v2 (shared-change #2):** the contract commits the fee; see the table above.

- **A (dashboard):** `net_usdt` can now be negative (`-0.050000` after a full refund). Render the sign; do not clamp. See decisions.md.
