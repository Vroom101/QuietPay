# Deploying the qualifying router (needs funded keys, run locally)

The bounty token is the official Whitechain test USDT, `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`, chain 1874.
This repo never deploys, mints or substitutes a token on a public network.

1. Fund the owner and relayer wallets with test WBT. The payer wallet must hold **zero WBT**; fund the payer and the
   refund signer with the official test USDT.
2. Qualifying deploy (the script requires chain 1874 and the official USDT address and refuses anything else):
   ```
   cd contracts
   export OWNER_PRIVATE_KEY=0x... RELAYER_ADDRESS=0x... MERCHANT_PAYOUT=0x... REFUND_SIGNER=0x... RPC_URL=...
   forge script script/DeployQualifying.s.sol --rpc-url $RPC_URL --simulate      # dry run
   forge script script/DeployQualifying.s.sol --rpc-url $RPC_URL --broadcast --legacy
   ```
3. Record the result in `contracts/deployments.json`, then `pnpm --filter @quietpay/shared sync:deployments`.
4. Verify the source: `forge verify-contract <router> src/PaymentRouter.sol:PaymentRouter --chain-id 1874 --verifier blockscout --verifier-url https://explorer.testnet.whitechain.io/api/ --constructor-args $(cast abi-encode "constructor(address,address)" <usdt> <owner>)`.
5. Host the relayer (`render.yaml`) and set its secrets in the dashboard.
6. Live evidence goes in `docs/lead/live-usdt.md`.

For local development only, `script/DeployLocal.s.sol` deploys a test mock token to anvil and refuses to run on chain 1874.
