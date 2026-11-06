# Live evidence with the official USDT

Chain 1874 (Whitechain Sepolia). Token: official test USDT [0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7](https://explorer.testnet.whitechain.io/address/0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7).
Nothing here uses a stand-in token. Funding is never simulated on the public testnet.

## Qualifying router (done)

- PaymentRouter: [0xb9D475cdd817900B45C356169c6FdC379B942d82](https://explorer.testnet.whitechain.io/address/0xb9D475cdd817900B45C356169c6FdC379B942d82), **source verified** on the explorer (Blockscout, `Pass - Verified`).
- Deploy transaction: [0xb2ce9853989c7920…](https://explorer.testnet.whitechain.io/tx/0xb2ce9853989c79207659f2c7aac30d165a4b152e84c2f76c265342273ea3c4fa) in block 12351795.
- Read back from the chain after deploy: `router.token()` is the official USDT, owner is the deployer wallet, the relayer wallet
  is allowlisted, the demo merchant is registered (payout and refund signer as in `contracts/deployments.json`),
  `PAY_TAG` equals `keccak256("quietpay.pay.v2")`.
- Deployed by `contracts/script/DeployQualifying.s.sol`, which requires chain 1874 and the official USDT address
  and never deploys a token.

## Wallet balances at the last check (2026-11-06, ~07:00 UTC)

| Wallet | Address | WBT | Official USDT |
| --- | --- | --- | --- |
| Owner (deployer) | 0x1E009f4fecE682514fCD5F284CaDdB1f46b10e2D | 1.68 | 0 |
| Relayer | 0x5e97E3E39ba9DaBbc1297392a2eE62A139F1ceeA | 50.3 (received the payer sweep) | 0.05 (fee) |
| Payer (must hold zero WBT) | 0x30Ab1c2f5d1D8794FdFE60EFa412F80D03037478 | ~0 (unsendable dust) | 99 (after paying 1, refunded 0.5) |
| Refund signer | 0xeF70298c52b917d2301F7331bfe7038550d2CD5d | 50 | 99.5 |

## First payment with the official USDT

**Done.** Order `0x186502c9e94cff5f4986050a34c8c0b62a62d7a47f26111ce8fdc503d76ce0a3`, 1.000000 USDT with a 0.050000 relay fee, block 12361192, [tx](https://explorer.testnet.whitechain.io/tx/0x1f2da1062f4c941382d1f0d3c7134c49858662d8eb3a68436b8f88fc7d892384).
The payer signed with nonce v2 (the fee is signed) and the relayer wallet submitted `pay`. All script checks passed: the receipt is settled, the payer paid exactly 1 USDT, the merchant got 0.95, the relayer got 0.05, and the router holds nothing.
Made with `packages/shared/scripts/live-payment.mjs` against the qualifying router and the official USDT (100 USDT was sent to the payer by a third party; nothing was minted).
The payer's 50 WBT was swept to the relayer first. It keeps 9,999,996,920 wei (about 0.00000001 WBT), which is less than one transfer costs, so it cannot pay gas. The script now treats a payer as zero-gas when its balance is below the cost of one transfer.

## Refund with the official USDT

**Done.** 0.5 USDT refunded to the payer, refundIndex 0, [tx](https://explorer.testnet.whitechain.io/tx/0x1ac62248eb3def54499896fd8bfc197436fcb83d9544fe94432c138c2d85127d), signed by the refund signer and submitted by the relayer with `packages/shared/scripts/first-refund.mjs`.
