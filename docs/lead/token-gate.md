# Token gate

Status: **read-only checks done; gasless live execution pending a funded relayer key.**

## Read from the live token (chain 1874, 2026-11-06)

Token `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, EIP-1967 proxy, implementation
`0x26425662d126412128967ecf0a02ec48573026f7`. Full results are in
[`packages/shared/token.json`](../../packages/shared/token.json).

| Fact | Result |
| --- | --- |
| name / symbol / decimals | Tether USD / USDT / **6** |
| `DOMAIN_SEPARATOR()` | `0xcdcfacb6...3d2a25` |
| EIP-712 domain | `{name: "Tether USD", version: "1", chainId: 1874, verifyingContract: token}` |
| `version()`, `eip712Domain()` | revert (not implemented). Version was derived by matching the domain separator. |
| `receiveWithAuthorization` | present, both the `(v,r,s)` and the `bytes signature` overloads |
| `transferWithAuthorization`, `cancelAuthorization`, `authorizationState`, `nonces` | present |
| `permit` | present, both overloads |
| `ReceiveWithAuthorization` typehash | `0xd099cc98...413de8` (matches the EIP-3009 string) |

## Decision (provisional)

**Primary path: `receiveWithAuthorization`.** All selectors are present and the domain separator
reproduces from `Tether USD` / `1` / 1874, so the typed data the widget signs will hash to the
domain the token verifies. The router uses the `(v,r,s)` overload.

## Still to do (needs a funded relayer key)

The remaining gate item is a live gasless execution: a payer wallet holding **zero WBT** signs, a
separate funded wallet submits. This is covered by the first real payment through the deployed router
(`docs/lead/first-payment.md`, checkpoint CP1). If that transaction reverts inside the token, escalate
to the Plan B design in the build plan (permit plus order intent).

## Fork evidence (2026-11-06)

`contracts/test/Fork.t.sol` runs the real `PaymentRouter` against the real USDT proxy on a fork of chain 1874
(`QUIETPAY_FORK_RPC=https://rpc.ankr.com/whitechain_testnet forge test --match-contract ForkTest`). With a payer holding
zero native balance, the real token accepted our `ReceiveWithAuthorization` signature (domain `Tether USD` / `1`),
consumed the nonce, paid the merchant and relayer exactly, rejected a replay, and also executed a refund from a
separate refundSigner. This is a simulation on forked state, **not** a broadcast transaction, so it does not replace
the live tx link below.

Transaction link: _pending (needs a funded relayer key)_
