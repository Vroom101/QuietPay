# Quietpay

A drop-in USDT payment kit for Whitechain Sepolia. The customer signs once and never holds gas or sends
a transaction. A relayer submits the payment to an on-chain router that pays the merchant and the relay
fee in one atomic step.

Built for ETHGlobal Mumbai 2026 (Whitechain: Operate and Scale tracks). **Testnet only.**

## Live on Whitechain Sepolia (chain 1874)

| | |
| --- | --- |
| PaymentRouter (verified) | [0x6a765694262E1c9CdDbb1C76008a61df7f58D86f](https://explorer.testnet.whitechain.io/address/0x6a765694262E1c9CdDbb1C76008a61df7f58D86f) |
| DemoUSDT (verified, testnet stand-in, not Tether) | [0x02Dd211C97b0611146ce9D673F9C56B4fbC9e6f4](https://explorer.testnet.whitechain.io/address/0x02Dd211C97b0611146ce9D673F9C56B4fbC9e6f4) |
| First payment from a payer with zero WBT | [tx](https://explorer.testnet.whitechain.io/tx/0xa7376dddb584f27c61ba67a793c86ef79dc040c077d899921cabe025bb0a4e70) |
| First partial refund | [tx](https://explorer.testnet.whitechain.io/tx/0xf628b683710360ccc20c1de1287e522d429112a1f431547bc798ea62384c0038) |

## How it works

```
Customer --sign once--> Widget --POST /v1/relay/pay--> Relayer --pay()--> PaymentRouter --> USDT
(0 WBT)                          guards, simulation, loss budget            receiveWithAuthorization
Merchant server --createOrder--> Relayer ----- signed webhook ---> Merchant server
```

- `contracts/`: PaymentRouter (Solidity 0.8.24, Foundry). The payer signs the token's own EIP-3009
  `ReceiveWithAuthorization` with `to` = router. The nonce is
  `keccak256(PAY_TAG, merchantId, orderId, payout, value)`, so changing the payout, amount or order
  invalidates the signature. One receipt per (merchant, order).
- `packages/shared`: zod schemas, error codes, typed-data builders, fixtures, mock relayer, generated ABI, token facts.
- `packages/relayer`: Fastify service with a guard pipeline, nonce manager, SQLite and signed webhooks with retry.
- `packages/merchant-sdk`: `createOrder`, `getOrder`, `verifyWebhook`, and a `refund` stub (P1).
- `packages/widget`: Lit `<quietpay-checkout>` plus a React wrapper.
- `apps/demo-store`, `apps/merchant-dashboard`: the demo shop and the orders view.

## Why onchain

The merchant payout and the relay fee move in one transaction anyone can audit. The receipt, the payout
address the payer agreed to and the fee cap are enforced by the contract, not by trusting the relayer. A
compromised relayer can refuse service but cannot redirect funds or exceed the fee cap.

## Setup

```
pnpm install
cd contracts && forge install && forge test       # 25 tests
forge build                                       # needed once for the anvil end-to-end test
cd .. && pnpm -r typecheck && pnpm -r test
pnpm --filter @quietpay/shared mock               # mock relayer on :8787 for frontend work
cp .env.example .env                              # fill values locally; never commit them
```

More: `docs/a/README.md` (frontend), `docs/b/quickstart.md` (merchant SDK), `docs/lead/` (token gate, deploy).

## Verified on the live token

Test USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` on chain 1874: 6 decimals, EIP-712 domain
`{Tether USD, 1}`, `receiveWithAuthorization` present. Details in `docs/lead/token-gate.md`.

## Limitations

- Demo-grade payer wallet: a random key encrypted with AES-GCM in IndexedDB. Not production custody.
- Testnet demo uses `DemoUSDT`, a valueless stand-in with a public faucet, because the official test USDT has no
  faucet. It is not Tether. Mainnet is a config change to the real USDT. USDT only, testnet only, no audit. No INR conversion or production custody is claimed.
- The relayer is a trusted gas sponsor: it can censor or pause, but cannot redirect funds or exceed the fee cap.
- The rate limiter is in memory; the gas loss budget is persisted.
- Not done yet: hosted relayer (payments so far ran through a local relayer), relayer refund endpoints, a browser run of the widget.
- P1 (refunds, ledger and verifier, x402) is not started.
