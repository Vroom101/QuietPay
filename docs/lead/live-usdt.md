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
| Relayer | 0x5e97E3E39ba9DaBbc1297392a2eE62A139F1ceeA | 0.30 | 0 |
| Payer (must hold zero WBT) | 0x30Ab1c2f5d1D8794FdFE60EFa412F80D03037478 | 0 | **0** |
| Refund signer | 0xeF70298c52b917d2301F7331bfe7038550d2CD5d | 0 | **0** |

## First payment with the official USDT

**pending: unfunded.** The payer holds no official USDT (the token has no public faucet and we do not mint a stand-in).
Needed: a small amount (for example 5 USDT) of `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` sent to the payer address above, with the payer's WBT balance kept at zero.
When it arrives the payment is made with `packages/shared/scripts/live-payment.mjs` (nonce v2 with the signed fee; the payer signs, the relayer wallet submits; it refuses a payer that holds any WBT and any chain or token but the qualifying pair). The script was proven end to end on anvil first. The link goes here.

## Refund with the official USDT

**pending: unfunded.** Needs official USDT in the refund signer wallet above, after the payment exists.
