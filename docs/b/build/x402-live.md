# x402 agent payments, live on Whitechain Sepolia (2026-11-07)

Chain 1874, official test USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, qualifying router `0xb9D475cdd817900B45C356169c6FdC379B942d82`.

`deploy/dev-stack.mjs` now runs the combined relayer + x402 facilitator (`packages/facilitator`, port 8790) and the paid API
(`apps/paid-api`, port 8791). Agent payments go straight to the merchant payout (`FACILITATOR_PAYTO`), and the ledger
service indexes them as `source=x402` rows next to checkout payments.

Run (after the stack is up), with the payer key mapped to `AGENT_PRIVATE_KEY`:

```sh
PAID_API_PUBLIC_URL=http://127.0.0.1:8791 FACILITATOR_PAYTO=<merchant payout> FACILITATOR_URL=http://127.0.0.1:8790 \
AGENT_EXPLORER_URL=https://explorer.testnet.whitechain.io pnpm --filter @quietpay/agent-demo exec node --env-file=<env> --import tsx src/main.ts
```

| Resource | Price | Settlement tx |
| --- | --- | --- |
| GET /v1/quote | 0.01 USDT | [0xff8982…f88a](https://explorer.testnet.whitechain.io/tx/0xff8982448111b5cf95e738eaa10646c8ef090f91640e29320b52ed61047cf88a) |
| GET /v1/signal | 0.02 USDT | [0xd172e2…d8f1](https://explorer.testnet.whitechain.io/tx/0xd172e25a0cbac4a738d463047b4d765dd32bee0a8043182ca10a1c4bda9bd8f1) |

Gasless proof printed by the agent: the payer's native balance is unchanged and `payerTransactionsSent: 0` (its
transaction count did not move). The agent demo used to require an exactly-zero native balance. It now requires a
balance too small to pay a 21000-gas transfer at the current gas price (this payer holds about 1e-8 WBT of dust), and
then checks that both the balance and the nonce are unchanged. That is a stronger check than "balance is zero".
