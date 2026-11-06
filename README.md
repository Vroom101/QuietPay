# Quietpay

A drop-in USDT payment kit for Whitechain Sepolia. The customer signs once and never holds gas or sends
a transaction. A relayer submits the payment to an on-chain router that pays the merchant and the relay
fee in one atomic step.

Built for ETHGlobal Mumbai 2026 (Whitechain: Operate and Scale tracks). **Testnet only.**

## Status

Quietpay targets the official Whitechain test USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` on chain 1874 only.
The demo uses no other token.

| Item | Status | Evidence |
| --- | --- | --- |
| PaymentRouter deployed and verified | **Done** (block 12351795) | [router](https://explorer.testnet.whitechain.io/address/0xb9D475cdd817900B45C356169c6FdC379B942d82), [deploy tx](https://explorer.testnet.whitechain.io/tx/0xb2ce9853989c79207659f2c7aac30d165a4b152e84c2f76c265342273ea3c4fa), `docs/lead/live-usdt.md` |
| Qualifying official-USDT payment (zero-gas payer) | **Done**: 1 USDT, fee 0.05, block 12361192 | [pay tx](https://explorer.testnet.whitechain.io/tx/0x1f2da1062f4c941382d1f0d3c7134c49858662d8eb3a68436b8f88fc7d892384), `docs/lead/live-usdt.md` |
| Official-USDT refund, on-chain | **Done**: 0.5 USDT refunded to the payer | [refund tx](https://explorer.testnet.whitechain.io/tx/0x1ac62248eb3def54499896fd8bfc197436fcb83d9544fe94432c138c2d85127d), `docs/lead/refund.md` |
| Refund API in the relayer and the dashboard refund button | **Not built** | `docs/lead/shared-change.md` |
| Hosted relayer | **Not done** (runs locally only) | `render.yaml` is ready |
| Browser checkout | **Not run in a real browser** | widget and store pass their unit tests against the mock relayer |
| Indexer and ledger export | **Done**, live-evidenced | `docs/lead/ledger.md` |
| Independent ledger verifier | **Not built** | `docs/lead/ledger.md` |

### Explorer proof

- Router [`0xb9D475cdd817900B45C356169c6FdC379B942d82`](https://explorer.testnet.whitechain.io/address/0xb9D475cdd817900B45C356169c6FdC379B942d82), source verified.
- Official test USDT [`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`](https://explorer.testnet.whitechain.io/address/0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7) on chain 1874.
- Payment [`0x1f2da106...`](https://explorer.testnet.whitechain.io/tx/0x1f2da1062f4c941382d1f0d3c7134c49858662d8eb3a68436b8f88fc7d892384): 1.000000 USDT paid, fee 0.050000, merchant received 0.95, payer paid about 0 WBT (zero gas).
- Refund [`0x1ac62248...`](https://explorer.testnet.whitechain.io/tx/0x1ac62248eb3def54499896fd8bfc197436fcb83d9544fe94432c138c2d85127d): 0.5 USDT returned to the payer.

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
- `packages/merchant-sdk`: `createOrder`, `getOrder`, `verifyWebhook`, and a `refund` stub. The relayer refund API is not built yet.
- `packages/widget`: Lit `<quietpay-checkout>` plus a React wrapper.
- `apps/demo-store`, `apps/merchant-dashboard`: the demo shop and the orders view.

## Why onchain

The merchant payout and the relay fee move in one transaction anyone can audit. The receipt, the payout
address the payer agreed to and the fee cap are enforced by the contract, not by trusting the relayer. A
compromised relayer can refuse service but cannot redirect funds or exceed the fee cap.

## Setup

```
pnpm install
cd contracts && forge install && forge test       # run forge test; CI shows the current count (fork test skips offline)
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
- Official test USDT only, testnet only, no audit. No INR conversion or production custody is claimed.
- Tokens sent directly to the router are not supported and cannot be recovered.
- The relayer is a trusted gas sponsor: it can censor or pause, but cannot redirect funds or exceed the fee cap.
- The rate limiter is in memory; the gas loss budget is persisted.
- Not done yet: independent ledger verifier, hosted relayer, real browser checkout against the deployed router, relayer refund API and dashboard refund button, x402 agent settlement.

## Security

Pen-tested in three rounds; see `docs/lead/pentest-round-1.md`.
