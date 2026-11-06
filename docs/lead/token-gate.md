# Token gate

## Status (three separate items)

1. **Official USDT ABI and EIP-712 domain checked: done.** Read from the live token on chain 1874 (details below and in
   `packages/shared/token.json`).
2. **Official USDT fork payment tested: done, but simulated funding.** `contracts/test/Fork.t.sol` runs the router
   against the real token on a fork. Balances are set with `deal()` on the fork only, so this is a compatibility check,
   **not** qualification evidence.
3. **Official USDT public-testnet payment and refund: done.** [Payment](https://explorer.testnet.whitechain.io/tx/0x1f2da1062f4c941382d1f0d3c7134c49858662d8eb3a68436b8f88fc7d892384) and [refund](https://explorer.testnet.whitechain.io/tx/0x1ac62248eb3def54499896fd8bfc197436fcb83d9544fe94432c138c2d85127d) on the qualifying router with the official USDT (details in `live-usdt.md`).

An earlier run used a self-minted stand-in token. It is not evidence and is superseded.

## Read from the live token (chain 1874, 2026-11-06)

Token `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, EIP-1967 proxy, implementation
`0x26425662d126412128967ecf0a02ec48573026f7`.

| Fact | Result |
| --- | --- |
| name / symbol / decimals | Tether USD / USDT / **6** |
| `DOMAIN_SEPARATOR()` | `0xcdcfacb6...3d2a25` |
| EIP-712 domain | `{name: "Tether USD", version: "1", chainId: 1874, verifyingContract: token}` |
| `version()`, `eip712Domain()` | revert (not implemented). The version was derived by matching the domain separator. |
| `receiveWithAuthorization` | present, both the `(v,r,s)` and the `bytes signature` overloads |
| `transferWithAuthorization`, `cancelAuthorization`, `authorizationState`, `nonces`, `permit` | present |
| `ReceiveWithAuthorization` typehash | `0xd099cc98...413de8` (matches the EIP-3009 string) |

## Decision

Primary path: `receiveWithAuthorization`. The router uses the `(v,r,s)` overload and pulls the payer's funds with `to` =
router. `transferWithAuthorization` is never used for checkout.
