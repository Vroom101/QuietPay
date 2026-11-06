# Agent client

An x402 v2 `exact`/EIP-3009 client for GET resources. It uses the shared typed-data builder and a viem-compatible local signer, the same account interface used by the widget. It does not import browser storage or send transactions. Supported tokens must be explicitly pinned by address, chain, EIP-712 name and version.

```ts
import { createAgent } from "@quietpay/agent-client";
import { privateKeyToAccount } from "viem/accounts";
import { token } from "@quietpay/shared";

const agent = createAgent({
  signer: privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`),
  chainId: token.chainId,
  asset: token.address as `0x${string}`,
  domainName: token.eip712Domain.name,
  domainVersion: token.eip712Domain.version,
  allowedOrigins: ["https://your-paid-api.example"],
  allowedPayTo: ["0x3333333333333333333333333333333333333333"],
  perCallLimit: 20_000n, // 0.02 USDT
  sessionBudget: 30_000n, // 0.03 USDT
  explorerUrl: "https://your-chain-explorer.example",
});
const response = await agent.fetch("https://your-paid-api.example/v1/quote");
console.log(await response.json(), agent.payments);
```

Only exact origins (scheme, host, port) and configured recipients are allowed. HTTPS is required except for loopback development. Redirects fail, credentials are omitted, resource URLs must match exactly, and token/domain/network and spending limits are checked before signing. Unsupported challenges fail closed. The wrapper creates its own GET request; it does not forward arbitrary request credentials or payment headers.

`agent.payments` returns copies of public receipt records. `reservedAmount` counts every authorization attempted, including failed signing, rejected payments and uncertain settlement. Reservations are synchronous before awaiting the signer, so concurrent calls share one budget. A session deliberately does not recycle reserved amounts after a failure.

Catch `AgentError` and retain `paymentId`. `payment_pending` and `payment_status_unknown` can be reconciled with `agent.retry(paymentId)`, which sends the identical signed payload without reserving or signing again. This client never automatically signs a replacement when a paid retry returns another 402. Unresolved calls block a fresh authorization for the same URL. A known settlement with failed resource delivery can also be retried by id, subject to the server's bounded delivery policy. A successful delivered payment cannot be retried through this API.

The session, signed payloads and budget are **in memory**. Keep the same instance alive while reconciling a pending payment; restarting creates a new session and must not be used as a recovery strategy. Durable multi-process budgets, authorization recovery after a process crash, smart-account signatures, Permit2, extensions, arbitrary HTTP methods and official-client interoperability are outside this implementation. Signatures stay private; never publish the signed payload as a receipt. EIP-3009 signs the transfer, not the resource URL; use trusted API owners and origins. A server-reported receipt is not an independent chain audit; the demo additionally checks transaction receipts and integration tests reconcile token events through the indexer.

Protocol references: [x402 v2 HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md) and [exact EVM scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md).
