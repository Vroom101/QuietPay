// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {MockAuthToken} from "../test/mocks/MockAuthToken.sol";

/// @notice LOCAL DEVELOPMENT ONLY (anvil). Deploys a test mock token and a router so the stack can be exercised offline.
///         It refuses to run on the qualifying chain (1874) and on any chain that already has the official token.
///
///   anvil &
///   OWNER_PRIVATE_KEY=0xac09... RELAYER_ADDRESS=0x... forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployLocal is Script {
    error NotForPublicNetworks(uint256 chainId);

    function guard() public view {
        if (block.chainid == 1874) revert NotForPublicNetworks(block.chainid);
        if (block.chainid != 31337) revert NotForPublicNetworks(block.chainid);
    }

    function run() external {
        guard();
        uint256 pk = vm.envUint("OWNER_PRIVATE_KEY");
        address owner = vm.addr(pk);
        address relayer = vm.envAddress("RELAYER_ADDRESS");

        vm.startBroadcast(pk);
        MockAuthToken token = new MockAuthToken();
        PaymentRouter router = new PaymentRouter(address(token), owner);
        router.setRelayer(relayer, true);
        router.registerMerchant(keccak256("demo-store"), owner, owner, 100_000);
        vm.stopBroadcast();

        console2.log("MockAuthToken (anvil only)", address(token));
        console2.log("PaymentRouter", address(router));
    }
}
