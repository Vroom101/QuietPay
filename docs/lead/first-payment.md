# First real payment

A payer wallet with **zero WBT and zero sent transactions** paid 5.00 demo USDT on Whitechain Sepolia (chain 1874)
by signing once. The relayer submitted the transaction and paid the gas.

- Payment transaction: https://explorer.testnet.whitechain.io/tx/0xa7376dddb584f27c61ba67a793c86ef79dc040c077d899921cabe025bb0a4e70
- PaymentRouter (source verified): https://explorer.testnet.whitechain.io/address/0x6a765694262E1c9CdDbb1C76008a61df7f58D86f
- DemoUSDT (source verified, testnet-only stand-in, not Tether): https://explorer.testnet.whitechain.io/address/0x02Dd211C97b0611146ce9D673F9C56B4fbC9e6f4
- Order `0x47dc295e48947d045de4615b279ac6364b5318b9438abce60ed630b60e5a28c1`, merchant `demo-store`

Checked on chain afterwards: payer paid exactly 5.00 USDT, still holds 0 WBT and has nonce 0; merchant payout
received 4.95; relayer received the 0.05 relay fee; the router holds 0.

Run from a local relayer pointed at the live chain (the hosted relayer is not deployed yet), using
`packages/shared/scripts/first-payment.mjs`.
