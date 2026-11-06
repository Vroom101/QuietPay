# Quietpay

A drop-in USDT payment kit for Whitechain Sepolia. The customer signs once and never holds gas or sends
a transaction. A relayer submits the payment to an on-chain router that pays the merchant and the relay
fee in one atomic step.

Built for ETHGlobal Mumbai 2026 (Whitechain: Operate and Scale tracks). **Testnet only.**

> First real payment from a zero-WBT payer: _pending. It needs funded testnet keys; see `docs/lead/deploy.md`._

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
- `packages/facilitator`: x402 v2 verification and settlement in a combined relayer process; [operations guide](packages/facilitator/README.md).
- `apps/paid-api`: two settlement-gated demo endpoints using SDK `paywall()` middleware.
- `packages/indexer`: persisted event polling, merchant ledger, exact CSV exports and independent completeness verification. See [the ledger guide](packages/indexer/README.md).
- `packages/relayer`: Fastify service with a guard pipeline, nonce manager, SQLite and signed webhooks with retry.
- `packages/merchant-sdk`: `createOrder`, `getOrder`, `verifyWebhook`, server-signed `refund`, and refund context/status reads.
- `packages/widget`: Lit `<quietpay-checkout>` plus a React wrapper.
- `apps/demo-store`, `apps/merchant-dashboard`: the demo shop and the orders view.

## Why onchain

The merchant payout and the relay fee move in one transaction anyone can audit. The receipt, the payout
address the payer agreed to and the fee cap are enforced by the contract, not by trusting the relayer. A
compromised relayer can refuse service but cannot redirect funds or exceed the fee cap.

## Setup

```
pnpm install
cd contracts && forge install && forge test       # 37 tests
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
- The rate limiter is in memory; signed transactions and gas reservations persist in SQLite.
- Run one relayer process per gas wallet/database. Pending payments recover after restart and use bounded same-nonce replacements.
- P0 operations, safety settings and read-only deployment checks: [`docs/b/p0-backend.md`](docs/b/p0-backend.md).
- Not done yet: live deployment and first real payment, hosted relayer, explorer verification, a browser run of the widget.
- Gasless partial/full refunds work locally. The merchant refundSigner supplies the full refund amount; the operator absorbs refund gas.
- Refunds require this branch's router build; an older non-upgradeable deployment must be replaced and its addresses synchronized.
- Ledger/export/verifier work locally; live exports need the deployed router and its deployment block. x402 facilitator/paid API are implemented locally; official-client interoperability and live settlement remain unverified.

The [agent client](packages/agent-client/README.md) and [scripted demo](apps/agent-demo/README.md) now exercise the paid API with per-call/session spending limits, recipient/origin allowlists and same-authorization retries. Sessions are in memory; live testnet proof remains pending.
