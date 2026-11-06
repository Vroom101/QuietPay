# QuietPay feedback for the Whitechain team

From the QuietPay project (ETHGlobal Mumbai). Chain 1874 (Whitechain Sepolia testnet). Status as of 2026-11-06.

## 1. What worked well

- The official test USDT (`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`) could be read directly from the live chain: name Tether USD, 6 decimals, EIP-1967 proxy.
- `receiveWithAuthorization` is present in both the `(v,r,s)` and `bytes signature` overloads. We use it as the primary checkout path.
- Blockscout source verification worked with `forge verify-contract --verifier blockscout`. The router shows `Pass - Verified`.
- A full cycle ran on the public testnet with the official USDT: a 1.000000 USDT payment (0.05 relay fee, merchant received 0.95), then a 0.5 USDT refund. Transaction links are in our live evidence file.

## 2. Where we got stuck

**Stand-in token first.** We first deployed an early router and a self-minted stand-in token on chain 1874. Outcome: superseded and not qualifying. We re-ran everything with the official USDT.

**Funding the payer with official USDT.** The payer wallet needed official test USDT. Outcome: a third party sent 100 USDT to the payer, and the payment ran after that.

**Payer gas.** Our deploy notes require the payer to hold zero WBT. Our payer held 50 WBT, which we swept to the relayer. The leftover balance (9,999,996,920 wei, about 0.00000001 WBT) is less than one transfer costs, so the payer cannot pay gas. Outcome: our test script now treats a payer as zero-gas when its balance is below the cost of one transfer.

**EIP-712 version.** `version()` and `eip712Domain()` revert on the official USDT. Outcome: we derived the domain version by matching the `DOMAIN_SEPARATOR()` value. The result is recorded in `packages/shared/token.json`.

## 3. What the docs lacked

- Where to obtain the official test USDT. Our deploy notes say to fund the wallets with it but do not say where it comes from.
- Whether `--legacy` is required for deployments on chain 1874. Our deploy command uses it, and the notes do not say why.
- Which EIP-712 version the official USDT uses, given that `version()` and `eip712Domain()` are not implemented.
- The minimum balance an account needs to pay gas for one transfer.

## 4. Suggestions

- Publish the official test USDT address and a funding route for it, next to the WBT faucet.
- Expose the EIP-712 version on the official USDT (`version()` or `eip712Domain()`), or document the expected value.
- Document the gas cost of one transfer on chain 1874, so that apps can tell users when a wallet cannot pay gas.
- Document whether Foundry deployments need `--legacy` on chain 1874, or state that they do not.
- Keep the Blockscout verification path documented, with the API URL used: `https://explorer.testnet.whitechain.io/api/`.

## Contributions from Person A and Person B

_To be added by A and B._
