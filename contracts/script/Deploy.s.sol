// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {DemoUSDT} from "../src/DemoUSDT.sol";

/// Usage (local shell only, DEPLOYER_PRIVATE_KEY never goes to hosting):
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
/// Env: DEPLOYER_PRIVATE_KEY, RELAYER_ADDRESS,
///      USDT_ADDRESS            existing token (the real USDT on mainnet), OR
///      DEPLOY_DEMO_TOKEN=true  deploy the testnet-only DemoUSDT with a public faucet,
///      optional DEMO_MERCHANT_ID, DEMO_PAYOUT, DEMO_REFUND_SIGNER, DEMO_MAX_RELAY_FEE
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(pk);
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        bool deployDemo = vm.envOr("DEPLOY_DEMO_TOKEN", false);

        vm.startBroadcast(pk);
        address usdt = deployDemo ? address(new DemoUSDT()) : vm.envAddress("USDT_ADDRESS");
        PaymentRouter router = new PaymentRouter(usdt, owner);
        router.setRelayer(relayer, true);

        bytes32 merchantId = vm.envOr("DEMO_MERCHANT_ID", bytes32(0));
        if (merchantId != bytes32(0)) {
            router.registerMerchant(
                merchantId,
                vm.envAddress("DEMO_PAYOUT"),
                vm.envOr("DEMO_REFUND_SIGNER", owner),
                vm.envOr("DEMO_MAX_RELAY_FEE", uint256(100_000)) // 0.10 USDT
            );
        }
        vm.stopBroadcast();

        console2.log("Token", usdt, deployDemo ? "(DemoUSDT, testnet only)" : "(existing)");
        console2.log("PaymentRouter", address(router));
        console2.log("owner", owner);
        console2.log("relayer", relayer);
    }
}
