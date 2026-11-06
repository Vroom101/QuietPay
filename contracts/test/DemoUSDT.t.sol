// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {DemoUSDT} from "../src/DemoUSDT.sol";

contract DemoUSDTTest is Test {
    DemoUSDT usdt;
    PaymentRouter router;
    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address payout = makeAddr("payout");
    uint256 payerPk = 0xA11CE;
    uint256 refundPk = 0xBEEF;
    address payer;
    address refundSigner;
    bytes32 constant MERCHANT = keccak256("demo-store");
    bytes32 constant ORDER = keccak256("o1");
    uint256 vA;
    uint256 vB;

    function setUp() public {
        vm.warp(1_000_000);
        payer = vm.addr(payerPk);
        refundSigner = vm.addr(refundPk);
        usdt = new DemoUSDT();
        router = new PaymentRouter(address(usdt), owner);
        vm.startPrank(owner);
        router.registerMerchant(MERCHANT, payout, refundSigner, 100_000);
        router.setRelayer(relayer, true);
        vm.stopPrank();
        vA = block.timestamp - 1;
        vB = block.timestamp + 5 minutes;
    }

    function _sign(uint256 pk, address from, uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(usdt.RECEIVE_TYPEHASH(), from, address(router), value, vA, vB, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdt.DOMAIN_SEPARATOR(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function test_metadataAndFaucetCap() public {
        assertEq(usdt.decimals(), 6);
        assertEq(usdt.symbol(), "USDT");
        usdt.faucet(payer, 1_000e6);
        assertEq(usdt.balanceOf(payer), 1_000e6);
        vm.expectRevert(bytes("faucet: 1 to 1000 USDT per call"));
        usdt.faucet(payer, 1_000e6 + 1);
        vm.expectRevert(bytes("faucet: 1 to 1000 USDT per call"));
        usdt.faucet(payer, 0);
    }

    function test_payAndRefundWorkWithTheDemoToken() public {
        usdt.faucet(payer, 100e6);
        usdt.faucet(refundSigner, 100e6);
        assertEq(payer.balance, 0);

        bytes32 n = router.computeNonce(MERCHANT, ORDER, payout, 25e6);
        bytes memory paySig = _sign(payerPk, payer, 25e6, n);
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, 25e6, 50_000, vA, vB, paySig);
        assertEq(usdt.balanceOf(payout), 25e6 - 50_000);

        bytes32 rn = router.computeRefundNonce(MERCHANT, ORDER, payer, 10e6, 0);
        bytes memory rsig = _sign(refundPk, refundSigner, 10e6, rn);
        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, 10e6, vA, vB, rsig);
        assertEq(usdt.balanceOf(payer), 100e6 - 25e6 + 10e6);
        assertEq(usdt.balanceOf(address(router)), 0);
    }

    function test_onlyThePayeeCanPullAnAuthorization() public {
        usdt.faucet(payer, 10e6);
        bytes32 n = keccak256("n");
        bytes memory sig = _sign(payerPk, payer, 1e6, n);
        (bytes32 r, bytes32 s, uint8 v) = (bytes32(0), bytes32(0), uint8(0));
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        vm.expectRevert(bytes("caller must be the payee"));
        usdt.receiveWithAuthorization(payer, address(router), 1e6, vA, vB, n, v, r, s);
    }
}
