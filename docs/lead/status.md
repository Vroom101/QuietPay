# Status

## CP0 (shared specs): done, tag `shared-v1`
- Token facts read from the live USDT; primary path is `receiveWithAuthorization`. Live gasless tx still pending a funded key.

## CP1 (router and first payment): partial
- Router built, 36 Foundry tests pass. Not deployed or verified; no real payment yet (needs funded keys).

## CP2 (full checkout): code complete locally, tag `cp2-local`
- Widget, relayer, SDK, store and dashboard merged; TS tests include an anvil end-to-end run with a zero-balance payer.
- Not yet run: live chain, hosted relayer, browser walkthrough.

## Partial refunds: code complete locally
- Router supports sequential, payer-bound partial/full refunds from the merchant refundSigner.
- Merchant-authenticated context, relay and status endpoints, SDK signing, durable recovery and signed refund webhooks implemented.
- Anvil integration proves payment, partial refund and remaining refund through the SDK, with payer and refundSigner both holding zero native currency.
- New ABI is generated from the Solidity build. Live deployment and dashboard refund controls remain pending.
