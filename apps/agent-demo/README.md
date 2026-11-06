# Scripted paying agent

C7's scripted agent buys a demo quote, then a demo signal. Each resource has its own authorization and transaction receipt. The API returns fixed demo data; this is not a live trading agent. No LLM service is needed.

Start the combined facilitator and paid API first; follow [their setup](../../packages/facilitator/README.md). Use Node 20 and a dedicated payer holding test USDT and **zero native currency**. The payer key is separate from the relayer key and is never sent to the API. Never commit keys or a real `.env`.

Set these environment variables in your terminal (or use Node's `--env-file` option with an untracked file):

| Variable               | Value                                               |
| ---------------------- | --------------------------------------------------- |
| `AGENT_PRIVATE_KEY`    | Dedicated test payer key                            |
| `PAID_API_PUBLIC_URL`  | Exact paid API origin, e.g. `http://localhost:8790` |
| `FACILITATOR_PAYTO`    | API owner's pinned recipient address                |
| `RPC_URL`              | Whitechain Sepolia RPC, chain 1874                  |
| `AGENT_EXPLORER_URL`   | Explorer base URL for the same chain                |
| `AGENT_PER_CALL_LIMIT` | Base units, default `20000` (0.02 USDT)             |
| `AGENT_SESSION_BUDGET` | Base units, default `30000` (0.03 USDT)             |

From the repository root, with Node 20 and dependencies installed:

```sh
pnpm --filter @quietpay/agent-demo start
# Or load an untracked root .env file:
pnpm --filter @quietpay/agent-demo exec node --env-file=../../.env --import tsx src/main.ts
```

The demo pins the token and EIP-712 domain from `packages/shared/token.json`; the CLI rejects a wrong RPC chain and a payer with native currency. For local Anvil use the integration test, which injects its own chain/token configuration into the client.

It prints JSON lines containing each endpoint's data, amount, transaction hash and explorer URL. Pending/unknown requests retry the original payload up to ten times without a new signature. After two paid calls it checks both transaction receipts and that the payer still holds zero native currency. Exit status is nonzero on failure. Receipt logs contain no key or signed payment payload.

The spending session is in memory. Do not restart to retry an uncertain payment: inspect the printed receipt/hash and reconcile first. The CLI does not persist signed authorizations or budgets and cannot recover them after a crash. Actual resource delivery is bounded by the facilitator's retry policy, not an exactly-once network guarantee.

Validation: the facilitator Anvil integration runs this exported `runDemo()` against the real HTTP API, checks two distinct successful transactions, zero payer native balance, exact token balances and inclusion of the transfers in an independently verified ledger export. Live testnet explorer links remain pending funded deployment; example links in local tests are placeholders.
