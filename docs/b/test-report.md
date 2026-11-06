# API and functionality test report

Date: 6 November 2026. Branch: `backend/remaining-build-plan`.
Published implementation: `0455f2a` (refunds), following `789107e` (P0).
This verification also strengthens `packages/relayer/test/e2e-anvil.test.ts` to use
running HTTP servers instead of Fastify request injection. Production code is unchanged.

## Results

| Check | Result |
| --- | --- |
| Solidity contract suite | 36 passed; no failures/skips |
| Solidity fuzzing | Payment fee conservation and refund conservation: 256 runs each |
| Shared package | 17 passed |
| Relayer | 79 passed, including Anvil integration |
| Merchant SDK | 19 passed |
| Widget | 27 passed (automated DOM/signing/storage tests) |
| Merchant dashboard | 4 passed |
| Demo-store server | 4 passed |
| Total workspace tests | 150 passed; no failures/skips |
| Workspace typechecks | Passed; strengthened integration test typechecked again |
| Workspace production builds | Passed |
| Strengthened HTTP/chain integration | Passed after the full-suite run |

Tests use Node 20, the pinned Solidity dependencies, Solidity 0.8.24 and Foundry.
Anvil is enabled explicitly; the integration test was executed, not skipped.

## Relayer endpoints exercised over real HTTP

These checks start the actual Fastify server on loopback, deploy MockUSDT and
PaymentRouter to Anvil and use the real viem chain adapter. No mocked chain is used
for this integration flow. Anvil's chain ID is 31337; this is not a testnet deployment.

| Endpoint | Successful behavior verified |
| --- | --- |
| `GET /v1/health` | Correct router, local chain ID and pause status |
| `POST /v1/orders` | 201, created order, expected amount/fee |
| `GET /v1/orders` | 200, authenticated merchant order listing |
| `GET /v1/orders/:id` | Created/settled/partially_refunded/refunded states and counters |
| `POST /v1/relay/pay` | Signed payment accepted; same signed retry returns same hash |
| `GET /v1/orders/:id/refund-context` | Confirmed payer/value, signer balance and next index |
| `POST /v1/relay/refund` | SDK signs and submits partial/full refunds through native fetch |
| `GET /v1/orders/:id/refunds` | Correct refund history after each settlement |
| `GET /v1/refunds/:id` | Correct refund ID, amount and settled status |
| `GET /v1/metrics` | Operator-authenticated balance, counters and pause status |
| `POST /v1/admin/pause` | Pause/unpause; a paused payment sends no transaction |

Additional real-HTTP checks: missing/invalid credentials return 401, merchant mismatch
returns 403, unknown order returns 404, malformed relay requests return 400, amount
mismatch returns 400, repeat payment with a fresh signature returns 409, requesting
refund context before settlement returns 422, paused relay returns 503, and CORS
OPTIONS returns 204 with the configured origin header.

The deployment preflight is also executed against the actual local contracts and
funded relayer, checking the chain, token, refund version, allowlist and registration.

## Full merchant flow exercised over real HTTP

The running demo-store server uses the real merchant SDK to contact the running relayer.
The webhook receiver forwards the exact signed body to the running demo-store server.

1. `POST /api/checkout` accepts 25.00 and rejects a negative total with 400.
2. The store creates the order through the SDK and relayer HTTP API.
3. A newly generated payer holding 100 test USDT and zero native currency signs the payment.
4. The relayer submits the payment and observes two confirmations.
5. Token balances show payer -25 USDT, merchant +24.95 USDT, relayer +0.05 USDT and router zero.
6. `POST /webhooks/quietpay` verifies the signature; `GET /api/orders/:id/paid` changes from false to true.
7. Re-delivering the same webhook returns duplicate=true. A modified body with the original signature returns 400.
8. A separately funded refundSigner with zero native currency signs a 5 USDT refund, then a 20 USDT refund through the SDK.
9. Both refunds settle, emit verified refund webhooks and appear in order status and refund history.
10. The payer returns to 100 USDT; refundSigner and router token balances are zero; merchant payout and relayer token fee remain unchanged.
11. Both payer and refundSigner retain zero native currency. The order keeps its original payment transaction hash.

The existing service/unit suites additionally cover rate limits, concurrent payer caps,
invalid signers/nonces/windows, insufficient refund balance, over-refunds, gas and price
caps, shared loss budgets, uncertain broadcasts, same-nonce replacements, database
reopening/recovery, webhook retries and stale receipt callbacks. Those fault-injection
checks use FakeChain; they are separate from the real-chain HTTP flow above.

## Practical limits and remaining work

- `contracts/deployments.json` still has a null router and transaction for chain 1874;
  live deployment/explorer verification is not complete.
- No populated root `.env` or hosted relayer URL was supplied. No live USDT payment,
  live refund, production hosting or hosted webhook connectivity was verified.
- Widget checks use jsdom; a real-browser walkthrough/Playwright smoke test is still pending.
- Dashboard refund initiation controls are not built. Backend and SDK refunds work;
  the widget can display refunded receipts. The demo-store paid record remains the
  original payment record rather than a separate refund UI.
- Ledger/export/verifier and x402 are not implemented, so they have no working endpoints to test.

No production behavior failures were found in the checks performed. Passing these
local checks does not establish live testnet or hosted-service readiness.

## Reproduce on Windows

```powershell
$env:ANVIL_BIN = "$env:LOCALAPPDATA\QuietPay-tools\foundry-v1.9.0\anvil.exe"
& "$env:LOCALAPPDATA\QuietPay-tools\foundry-v1.9.0\forge.exe" test --root contracts -vv
npm exec --yes --package=node@20 -- corepack pnpm -r test
npm exec --yes --package=node@20 -- corepack pnpm -r typecheck
npm exec --yes --package=node@20 -- corepack pnpm -r build
```

The test and report changes are local and uncommitted. No deployment, push or live-chain
transaction was performed as part of this verification.

## Subsequent ledger implementation

After the payment/refund checkpoint above, packages/indexer adds 30 tests, bringing
the current workspace total to 180 passing tests with no skipped integrations.
Workspace typechecks and app/widget builds pass. The new Anvil integration exercises
chain indexing, partial/full refunds, direct-transfer accounting, authenticated ledger
HTTP endpoints, CSV/metadata exports, independent verification, tamper detection,
CLI exit status and an actual chain reorg. See packages/indexer/README.md for operation
and the declared-range/RPC trust boundary. Live deployment and UI integration remain pending.
