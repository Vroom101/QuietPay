# x402 interoperability check (W6)

Date: 2026-11-06. Local anvil only (chain id 1874 set with `anvil --chain-id 1874`, mock EIP-3009 token, real PaymentRouter). No live transaction, no real token, no key beyond a throwaway one generated per run.

## What was tested
Official packages, installed only in a throwaway folder outside the repo (not added to any package.json or lockfile): `@x402/core`, `@x402/fetch`, `@x402/evm`, all version 2.30.0, plus `viem`. Docs read once: docs.x402.org buyer quickstart (the page lists `x402Client` from `@x402/core/client`, `wrapFetchWithPayment` from `@x402/fetch`, `ExactEvmScheme` from `@x402/evm/exact/client`, scheme registration per CAIP-2 namespace such as `eip155:*`, and `spendControls.allowedAssets` for non-default tokens; it does not describe the PAYMENT-REQUIRED / PAYMENT-SIGNATURE header encoding or size limits, so those were not verified against the docs, only by the run below).

Harness: `packages/facilitator/test/build-x402-official-client.test.ts` (skipped unless `X402_CLIENT_DIR` points at the throwaway folder). It starts anvil, our facilitator and `apps/paid-api`, funds a fresh payer, and runs the unmodified client script (`docs/b/build/x402-official-client.mjs.txt`) against `GET /v1/quote`.

## Results
1. Default client (only `register("eip155:*", new ExactEvmScheme(signer))`): FAILS before signing anything. Error: "All payment requirements were rejected by spendControls: only default assets or entries in spendControls.allowedAssets are allowed." The official client only pays assets it recognises (USDC-style defaults, capped at $1) unless told otherwise. Our token is not in its default table. Nothing was patched; the client simply refuses.
2. Same client with its own documented opt-in, `client.setSpendControls({ allowedAssets: [{ network: "eip155:1874", asset: <token>, maxAmountPerPayment: "1000000" }] })`: WORKS. It selected network `eip155:1874` through the `eip155:*` wildcard (the chain id is taken from the CAIP-2 string and used in the EIP-712 domain together with our `extra.name`/`extra.version`), signed an EIP-3009 authorization, our facilitator settled it on anvil, the payee received 10000 units (0.01), the API returned 200 with data exactly once and a PAYMENT-RESPONSE header.

## What this does and does not show
- The client CAN select the custom chain eip155:1874; no change is needed on our side for that.
- The client CANNOT pay our token out of the box: an integrator must add an `allowedAssets` entry (or `allowedAssets: true` / `spendControls: false`). That is a client-side policy choice of the official SDK and must be in our integration docs. We cannot change it from the server side.
- Verified only against a local mock token with the same EIP-712 domain ("Tether USD", "1"). Not verified against the real Whitechain testnet or the official test USDT, and not against a hosted/third-party facilitator or the `@x402/core` resource-server/facilitator classes (we only tested the buyer side).
- Header size/encoding rules were not confirmed from documentation; the run shows our decoder accepts what the official client emits.
