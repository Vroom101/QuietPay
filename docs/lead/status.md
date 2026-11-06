# Status

## CP0 (shared specs): done, tag `shared-v1`
- Token facts read from the live USDT; primary path is `receiveWithAuthorization`. Live gasless tx still pending a funded key.

## CP1 (router and first payment): partial
- Router built, 25 Foundry tests pass. Not deployed or verified; no real payment yet (needs funded keys).

## CP2 (full checkout): code complete locally, tag `cp2-local`
- Widget, relayer, SDK, store and dashboard merged; TS tests include an anvil end-to-end run with a zero-balance payer.
- Not yet run: live chain, hosted relayer, browser walkthrough.

## Update 2026-11-06: live on testnet
- DemoUSDT and PaymentRouter (with refunds) deployed and source-verified on chain 1874.
- Real gasless payment from a zero-WBT payer and a real partial refund recorded (see `first-payment.md`, `refund.md`).
- Still open: hosted relayer, relayer refund endpoints, browser run of the widget, P1.
