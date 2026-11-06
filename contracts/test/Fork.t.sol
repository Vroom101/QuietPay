// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

interface IUSDT {
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/// Runs the router against the REAL test USDT proxy on a fork of Whitechain Sepolia.
/// Skipped unless QUIETPAY_FORK_RPC is set:
///   QUIETPAY_FORK_RPC=https://rpc.ankr.com/whitechain_testnet forge test --match-contract ForkTest -vv
contract ForkTest is Test {
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    PaymentRouter router;
    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address payout = makeAddr("payout");
    uint256 payerPk = 0xA11CE;
    uint256 refundPk = 0xBEEF;
    address payer;
    address refundSigner;
    bytes32 constant MERCHANT = keccak256("demo-store");
    bytes32 constant ORDER = keccak256("fork-order-1");
    uint256 constant PRICE = 25_000_000;
    uint256 vA;
    uint256 vB;

    function setUp() public {
        string memory rpc = vm.envOr("QUIETPAY_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        payer = vm.addr(payerPk);
        refundSigner = vm.addr(refundPk);
        router = new PaymentRouter(USDT, owner);
        vm.startPrank(owner);
        router.registerMerchant(MERCHANT, payout, refundSigner, 100_000);
        router.setRelayer(relayer, true);
        vm.stopPrank();
        deal(USDT, payer, 100_000_000);
        deal(USDT, refundSigner, 100_000_000);
        vA = block.timestamp - 1;
        vB = block.timestamp + 5 minutes;
    }

    function _sign(uint256 pk, address from, uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(RECEIVE_TYPEHASH, from, address(router), value, vA, vB, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IUSDT(USDT).DOMAIN_SEPARATOR(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_fork_payThenRefundOnRealToken() public {
        assertEq(payer.balance, 0, "payer has no native gas token");

        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        bytes memory sig = _sign(payerPk, payer, PRICE, nonce);
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, PRICE, 50_000, vA, vB, sig);

        assertTrue(IUSDT(USDT).authorizationState(payer, nonce), "real token consumed the nonce");
        assertEq(IUSDT(USDT).balanceOf(payout), PRICE - 50_000);
        assertEq(IUSDT(USDT).balanceOf(relayer), 50_000);
        assertEq(IUSDT(USDT).balanceOf(address(router)), 0);
        assertEq(IUSDT(USDT).balanceOf(payer), 100_000_000 - PRICE);

        // Replay of the same signed payment fails on the real token too.
        vm.prank(relayer);
        vm.expectRevert();
        router.pay(MERCHANT, ORDER, payer, PRICE, 50_000, vA, vB, sig);

        // Refund 10 USDT from the refundSigner to the stored payer.
        bytes32 rn = router.computeRefundNonce(MERCHANT, ORDER, payer, 10_000_000, 0);
        bytes memory rsig = _sign(refundPk, refundSigner, 10_000_000, rn);
        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, 10_000_000, vA, vB, rsig);
        assertEq(IUSDT(USDT).balanceOf(payer), 100_000_000 - PRICE + 10_000_000);
        assertEq(IUSDT(USDT).balanceOf(refundSigner), 90_000_000);
        assertEq(router.receipts(MERCHANT, ORDER).refunded, 10_000_000);
    }
}
