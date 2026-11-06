# Deploying (needs funded keys, run locally)

1. Fund a deployer wallet and a relayer wallet with test WBT from the Whitechain faucet.
2. Deploy and register:
   ```
   cd contracts
   export DEPLOYER_PRIVATE_KEY=0x... USDT_ADDRESS=0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7
   export RELAYER_ADDRESS=0x... DEMO_MERCHANT_ID=$(cast keccak demo-store) DEMO_PAYOUT=0x...
   forge script script/Deploy.s.sol --rpc-url https://rpc.ankr.com/whitechain_testnet --broadcast
   ```
3. Put the router address and tx into `contracts/deployments.json`, then run
   `pnpm --filter @quietpay/shared sync:deployments`.
4. Verify the source on the explorer with `forge verify-contract`, using the explorer verifier URL.
   Build settings: solc 0.8.24, via_ir, optimizer 200 runs, evm paris.
5. Host the relayer (`render.yaml`), set secrets in the dashboard, fund the relayer with WBT.
   Set `EXPLORER_BASE_URL` to the real explorer (not confirmed during the build).
6. Run `scripts/first-payment.mjs` with a payer that holds USDT and zero WBT. Put the explorer link in
   `docs/lead/first-payment.md` and the README.

Freeze contract signatures at hour 22.
