# Status

## CP0 (shared specs): done, tag `shared-v1`
- Token facts read from the live USDT; primary path is `receiveWithAuthorization`. Live gasless tx recorded on 2026-11-06 (see the update below).

## CP1 (router and first payment): done on 2026-11-06
- Router deployed and verified; real payment from a zero-WBT payer recorded (see the update below).

## CP2 (full checkout): code complete locally, tag `cp2-local`
- Widget, relayer, SDK, store and dashboard merged; TS tests include an anvil end-to-end run with a zero-balance payer.
- Live chain run via a local relayer; hosted relayer and browser walkthrough still open.

## Update 2026-11-06: live on testnet
- DemoUSDT and PaymentRouter (with refunds) deployed and source-verified on chain 1874.
- Real gasless payment from a zero-WBT payer and a real partial refund recorded (see `first-payment.md`, `refund.md`).
- Still open: hosted relayer, relayer refund endpoints, browser run of the widget, P1.
- Indexer, ledger and CSV export built (`packages/indexer`, `docs/lead/ledger.md`); live sample in `docs/lead/samples/`.
