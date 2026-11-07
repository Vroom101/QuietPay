# QuietPay feedback for the Whitechain team

From the QuietPay project (ETHGlobal Mumbai 2026, Whitechain tracks). Chain 1874 (Whitechain Sepolia testnet).
Status as of 2026-11-07. Everything below comes from building and running a real payment stack on the public testnet
with the official test USDT. Where a number is quoted, it was measured by our own software (our relayer, indexer or
test scripts), and we say how.

## 1. Summary

| Area | Verdict |
| --- | --- |
| Chain and RPC | Stable for everything we did. Public RPC limits are documented and we stayed under them. |
| Official test USDT | Works for our design (`receiveWithAuthorization`, `transferWithAuthorization`, 6 decimals). Two documentation gaps: the EIP-712 version and where to get the token. |
| Explorer (Blockscout) | Contract verification and transaction pages worked first time. |
| Gas | Cheap and predictable. A QuietPay payment cost the relayer about 0.0013 WBT on average. |
| Wallets (MetaMask) | Adding the network and signing EIP-712 typed data on chain 1874 worked. |
| Ecosystem tooling (x402 clients) | Off-the-shelf x402 clients do not know chain 1874 or the official USDT yet. |

## 2. What worked well

- **Official test USDT is a good target.** `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` could be read directly from the
  live chain: name `Tether USD`, 6 decimals, EIP-1967 proxy.
- **EIP-3009 is present in full.** `receiveWithAuthorization` exists in both the `(v,r,s)` and the `bytes signature`
  overloads, and `transferWithAuthorization` works for x402. We use `receiveWithAuthorization` for checkout (only the
  router can submit it, so nobody can front-run the signature) and `transferWithAuthorization` for x402.
- **Blockscout verification.** `forge verify-contract --verifier blockscout` worked. The router shows `Pass - Verified`.
- **Full payment cycle on the public testnet.** A 1.000000 USDT payment (0.05 relay fee, merchant received 0.95), a
  0.5 USDT refund, and later many more payments from a browser, all with a payer that held no usable WBT (see section 4).
- **`eth_getLogs` and receipts are reliable.** Our indexer re-derives a merchant ledger purely from chain logs and an
  independent verifier re-derived the same file from the chain (checked again on 2026-11-07: OK, 17 rows from 40 events). The first sync from the deploy block (about 59,000
  blocks at the time) finished in one to two minutes against the public RPC.
- **Fast settlement.** Over our recorded payments the time from order creation to a settled receipt had a median of
  6 seconds and a 90th percentile of 7 seconds (small sample, a handful of live payments, measured from our relayer's
  order timestamps).
- **Gas cost.** Our relayer records `gasUsed x effectiveGasPrice` per transaction. The average for a `pay` transaction
  was about 0.0013 WBT (0.001284 WBT in our last dashboard reading). That is small enough that a flat 0.05 USDT relay fee
  covers it at any sensible WBT price.
- **Public RPC limits are documented** (50 requests per second sustained, burst 500 per IP, `429` with `Retry-After`).
  We stayed under them by chunking `eth_getLogs` to 1,000 blocks and polling every 5 seconds.
- **Adding the network to MetaMask** works with the documented values, and `eth_signTypedData_v4` on chain 1874 returned
  signatures that recover correctly.

## 3. Where we got stuck

**Stand-in token first.** We first deployed an early router and a self-minted stand-in token on chain 1874. That was
superseded and is not qualifying. We re-ran everything with the official USDT. The old deployment is kept only as
history in `contracts/deployments.json` and is marked `qualifying: false`.

**Funding the payer with official USDT.** The payer wallet needed official test USDT. A third party sent 100 USDT to the
payer and the payments ran after that. We did not and will not mint or fake a token on the public testnet.

**Payer gas.** Our design requires the payer to be unable to pay gas. Our payer held 50 WBT, which we swept to the
relayer. The leftover balance (9,999,996,920 wei, about 0.00000001 WBT) is less than one transfer costs, so the payer
cannot pay gas. Our checks therefore treat a payer as gasless when its balance is below the cost of one transfer and
when its balance and its transaction count do not change during a run. This works, but dust makes an "exactly zero
balance" rule impossible to meet.

**EIP-712 version.** `version()` and `eip712Domain()` revert on the official USDT. We derived the domain version by
matching the `DOMAIN_SEPARATOR()` value. The result (`{ name: "Tether USD", version: "1" }`) is recorded in
`packages/shared/token.json`. A wrong guess here gives signatures that the token rejects with a bare "invalid
signature" revert, which is hard to debug.

**x402 clients do not know Whitechain.** We tested the official x402 buyer packages (`@x402/core`, `@x402/fetch`,
`@x402/evm`, 2.30.0) against our paid API and facilitator on a local chain id 1874 node with a token that has the same
EIP-712 domain. The default client refuses before signing anything: "only default assets or entries in
spendControls.allowedAssets are allowed". It does work once the integrator adds an `allowedAssets` entry for
`eip155:1874` and the token. We did not test the official client against the live Whitechain testnet; our own agent
client did make live agent payments (section 4).

**An admin-controlled token.** The test USDT is a proxy whose admin can pause it or blacklist addresses. That is
reasonable for a stable-coin issuer, but it means any router payment reverts if a payer or the router is blocked. We
could not find a statement of the admin policy for the test token.

## 4. Live evidence we can point to

All with the official USDT on chain 1874, no stand-in token.

| What | Evidence |
| --- | --- |
| Router deployed and source verified (block 12351795) | `0xb9D475cdd817900B45C356169c6FdC379B942d82` |
| 1 USDT payment, fee 0.05, zero-gas payer | tx `0x1f2da1062f4c941382d1f0d3c7134c49858662d8eb3a68436b8f88fc7d892384` |
| 0.5 USDT refund | tx `0x1ac62248eb3def54499896fd8bfc197436fcb83d9544fe94432c138c2d85127d` |
| 1 USDT checkout through the relayer API | tx `0xd3872f547769df1d1b5652ee14b4a0821d8c9e3e31b1c792cf871d0900b149a6` |
| x402 agent payment, 0.01 USDT (payer sent 0 transactions) | tx `0xff8982448111b5cf95e738eaa10646c8ef090f91640e29320b52ed61047cf88a` |
| x402 agent payment, 0.02 USDT | tx `0xd172e25a0cbac4a738d463047b4d765dd32bee0a8043182ca10a1c4bda9bd8f1` |
| Browser runs (wallet checkout, refunds, subscription period, payment link) | `deploy/browser-e2e-real.mjs`, `deploy/browser-subscription-real.mjs`, `deploy/browser-paylink-real.mjs` |

Explorer base: `https://explorer.testnet.whitechain.io`. More detail in `docs/lead/live-usdt.md` and
`docs/b/build/x402-live.md`.

## 5. What the docs lacked

- Where to obtain the official test USDT. Our notes say to fund the wallets with it, but not where it comes from.
- Which EIP-712 version the official USDT uses, given that `version()` and `eip712Domain()` are not implemented.
- Whether `--legacy` is required for deployments on chain 1874. Our deploy command uses it, and the notes do not say why.
- The minimum balance an account needs to pay gas for one transfer, and the typical gas cost of a token transfer and of
  an EIP-3009 call.
- Block time and finality: how long until a block can be treated as final, and whether the `safe` and `finalized` block
  tags are supported by the public RPC. We rely on a confirmation count (2) and did not test the tags against the live
  node.
- Whether `eth_getLogs` has a maximum block range on the public RPC. We chunk to 1,000 blocks and never hit a limit, but
  we do not know the actual limit.
- The admin policy (pause and blacklist) of the test USDT proxy.
- A canonical machine-readable network entry (chain id, RPC, explorer, currency) for wallets and libraries. We found the
  RPC in the developer docs and a different third-party RPC in older notes of ours, so we standardised on the official
  one.

## 6. Suggestions

1. Publish the official test USDT address and a funding route for it, next to the WBT faucet.
2. Expose the EIP-712 version on the official USDT (`version()` or `eip712Domain()`), or document the expected value.
3. Document gas costs on chain 1874 (a plain transfer, an ERC-20 transfer, an EIP-3009 call) so apps can tell users when
   a wallet cannot pay gas.
4. State whether Foundry deployments need `--legacy` on chain 1874.
5. Document block time, finality and supported block tags.
6. Register Whitechain Sepolia (`eip155:1874`) and the official test USDT in the default asset tables of the common
   x402 clients, or publish a copy-paste `allowedAssets` snippet. This would let any x402 agent pay a Whitechain API
   out of the box.
7. Keep the Blockscout verification path documented, with the API URL used: `https://explorer.testnet.whitechain.io/api/`.
8. A documented, supported way for apps to sponsor gas (a paymaster or a relayer recommendation) would help gasless
   checkout projects like ours decide how to build; today every team writes its own relayer.

## 7. Contributions by area

QuietPay was built in three parts. What each part found about building on Whitechain:

**Contracts, ledger and verification (lead).**
- A router that settles the merchant payout, the relay fee and a receipt in one atomic transaction, with the fee and the
  payout bound into the payer's signed nonce.
- A ledger indexer and an independent verifier that re-derive the same CSV from chain logs only.
- Findings: sections 3 and 5 above (EIP-712 version, payer dust, funding).

**Frontend (Person A).**
- The landing page, demo store, hosted checkout, merchant dashboard, MetaMask payment flow.
- Finding: wallets show a raw 32-byte nonce for EIP-712 typed data from the token, so the app must show the amount, the
  merchant payout and the relay fee itself before the wallet opens. Our widget verifies the order against the router
  before asking for a signature.

**Backend (Person B).**
- The relayer, SDK, refunds, webhooks, x402 facilitator, paid API and agent client, subscriptions and payment links.
- Finding: reliable broadcast needs a signed-transaction journal (we persist the raw transaction and its hash before
  sending, because a timed-out `eth_sendRawTransaction` may or may not have been accepted) and a reconciliation loop
  for pending transactions. That worked well against the public RPC.
