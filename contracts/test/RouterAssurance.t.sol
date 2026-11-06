// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {MockAuthToken} from "./mocks/MockAuthToken.sol";

/// Tests added to kill mutants that survived the low-memory sweep (scripts/mutate-router.py). One test per survivor.
contract RouterAssuranceTest is Test {
    PaymentRouter router;
    address owner = makeAddr("owner");
    address stranger = makeAddr("stranger");

    function setUp() public {
        router = new PaymentRouter(address(new MockAuthToken()), owner);
    }

    /// Survivor: `function unpause() external onlyOwner` with onlyOwner removed.
    function test_onlyOwnerCanUnpause() public {
        vm.prank(owner);
        router.pause();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        router.unpause();
        assertTrue(router.paused());
        vm.prank(owner);
        router.unpause();
        assertFalse(router.paused());
    }

    function test_onlyOwnerCanPause() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        router.pause();
        assertFalse(router.paused());
    }

    /// Survivor: `payout == address(0) || refundSigner == address(0)` flipped to `&&` (only both-zero reverted).
    function test_registerMerchantRejectsEitherZeroAddress() public {
        bytes32 m = keccak256("m");
        vm.startPrank(owner);
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        router.registerMerchant(m, address(0), makeAddr("signer"), 100_000);
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        router.registerMerchant(m, makeAddr("payout"), address(0), 100_000);
        router.registerMerchant(m, makeAddr("payout"), makeAddr("signer"), 100_000); // both set: accepted
        vm.stopPrank();
    }

    // ---- uncovered security branches found by `forge coverage --ir-minimum` (lines 98, 115, 116, 228, 262)

    function test_constructorRejectsZeroToken() public {
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        new PaymentRouter(address(0), owner);
    }

    function test_setPayoutRejectsUnknownMerchantAndZeroPayout() public {
        bytes32 m = keccak256("m2");
        vm.startPrank(owner);
        vm.expectRevert(PaymentRouter.UnknownMerchant.selector);
        router.setPayout(m, makeAddr("p"));
        router.registerMerchant(m, makeAddr("p"), makeAddr("s"), 100_000);
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        router.setPayout(m, address(0));
        vm.stopPrank();
    }

    function test_payRejectsZeroPayer() public {
        bytes32 m = keccak256("m3");
        address relayer = makeAddr("relayer");
        vm.startPrank(owner);
        router.registerMerchant(m, makeAddr("p"), makeAddr("s"), 100_000);
        router.setRelayer(relayer, true);
        vm.stopPrank();
        vm.warp(1_000_000);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        router.pay(m, keccak256("o"), address(0), 5_000_000, 0, block.timestamp - 1, block.timestamp + 5 minutes, new bytes(65));
    }

    function test_refundRejectsShortSignature() public {
        MockAuthToken t = new MockAuthToken();
        PaymentRouter r = new PaymentRouter(address(t), owner);
        uint256 payerPk = 0xA11CE;
        address payer = vm.addr(payerPk);
        address payout = makeAddr("p");
        address relayer = makeAddr("relayer");
        bytes32 m = keccak256("m4");
        bytes32 o = keccak256("o4");
        vm.startPrank(owner);
        r.registerMerchant(m, payout, makeAddr("s"), 100_000);
        r.setRelayer(relayer, true);
        vm.stopPrank();
        t.mint(payer, 10_000_000);
        vm.warp(1_000_000);
        uint256 a = block.timestamp - 1;
        uint256 b = block.timestamp + 5 minutes;
        bytes32 nonce = r.computeNonce(m, o, payout, 5_000_000, 0);
        bytes32 sh = keccak256(abi.encode(t.RECEIVE_TYPEHASH(), payer, address(r), 5_000_000, a, b, nonce));
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(payerPk, keccak256(abi.encodePacked(hex"1901", t.DOMAIN_SEPARATOR(), sh)));
        vm.prank(relayer);
        r.pay(m, o, payer, 5_000_000, 0, a, b, abi.encodePacked(rr, ss, v));
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.BadSignatureLength.selector);
        r.refund(m, o, 1_000_000, a, b, new bytes(64));
    }
}
