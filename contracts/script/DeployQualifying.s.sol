// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

interface IToken {
    function name() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// @notice Qualifying deployment: Whitechain Sepolia (1874) with the OFFICIAL test USDT, and nothing else.
///         It never deploys or mints a token. It refuses any other chain or token before sending a transaction.
///
///   export OWNER_PRIVATE_KEY=0x... RELAYER_ADDRESS=0x... MERCHANT_PAYOUT=0x... REFUND_SIGNER=0x...
///   forge script script/DeployQualifying.s.sol --rpc-url $RPC_URL --simulate     # dry run
///   forge script script/DeployQualifying.s.sol --rpc-url $RPC_URL --broadcast --legacy
///
/// Record the result with the shared package script record:deployment (writes contracts/deployments.json).
contract DeployQualifying is Script {
    uint256 public constant QUALIFYING_CHAIN_ID = 1874;
    address public constant OFFICIAL_USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    // Facts read from the live token (packages/shared/token.json). A test asserts these equal the JSON.
    string public constant TOKEN_NAME = "Tether USD";
    uint8 public constant TOKEN_DECIMALS = 6;
    uint256 public constant DEFAULT_MAX_RELAY_FEE = 100_000; // 0.10 USDT

    error WrongChain(uint256 actual);
    error WrongToken(address actual);
    error TokenMismatch();
    error FeeTooHigh(uint256 maxRelayFee);
    error BadParty(string role);

    /// @dev Hard ceiling on the per-merchant relay fee cap read from the environment: 1 USDT (6 decimals).
    uint256 public constant MAX_RELAY_FEE_CEILING = 1_000_000;

    function _checkParty(string memory role, address a, address owner, address usdt, address router_) internal pure {
        if (a == address(0) || a == owner || a == usdt || a == router_) revert BadParty(role);
    }

    /// @dev Reverts unless the chain and token are the qualifying pair. Public so tests can call it directly.
    function guard(address usdt) public view {
        if (block.chainid != QUALIFYING_CHAIN_ID) revert WrongChain(block.chainid);
        if (usdt != OFFICIAL_USDT) revert WrongToken(usdt);
    }

    /// @dev Deploys the router and registers the demo merchant. Must be called inside a broadcast (or a test prank).
    function deploy(
        address usdt,
        address owner,
        address relayer,
        address payout,
        address refundSigner,
        bytes32 merchantId,
        uint256 maxRelayFee
    ) public returns (PaymentRouter router) {
        guard(usdt);
        if (maxRelayFee > MAX_RELAY_FEE_CEILING) revert FeeTooHigh(maxRelayFee);
        // The router address is the CREATE address of this contract (or of the broadcaster when run under forge).
        router = new PaymentRouter(usdt, owner);
        _checkParty("relayer", relayer, owner, usdt, address(router));
        _checkParty("payout", payout, owner, usdt, address(router));
        _checkParty("refundSigner", refundSigner, owner, usdt, address(router));
        router.setRelayer(relayer, true);
        router.registerMerchant(merchantId, payout, refundSigner, maxRelayFee);

        // Read back and assert what was actually deployed matches the token facts and the constant.
        if (address(router.token()) != OFFICIAL_USDT) revert TokenMismatch();
        if (keccak256(bytes(IToken(usdt).name())) != keccak256(bytes(TOKEN_NAME))) revert TokenMismatch();
        if (IToken(usdt).decimals() != TOKEN_DECIMALS) revert TokenMismatch();
    }

    function run() external {
        guard(OFFICIAL_USDT); // fail before any key is read or any transaction is built
        uint256 pk = vm.envUint("OWNER_PRIVATE_KEY");
        address owner = vm.addr(pk);
        address relayer = vm.envAddress("RELAYER_ADDRESS");
        address payout = vm.envAddress("MERCHANT_PAYOUT");
        address refundSigner = vm.envAddress("REFUND_SIGNER");
        bytes32 merchantId = keccak256(bytes(vm.envOr("MERCHANT_SLUG", string("demo-store"))));
        uint256 maxFee = vm.envOr("MAX_RELAY_FEE", DEFAULT_MAX_RELAY_FEE);

        vm.startBroadcast(pk);
        PaymentRouter router = deploy(OFFICIAL_USDT, owner, relayer, payout, refundSigner, merchantId, maxFee);
        vm.stopBroadcast();

        console2.log("PaymentRouter", address(router));
        console2.log("USDT", OFFICIAL_USDT);
        console2.log("owner", owner);
        console2.log("relayer", relayer);
    }
}
