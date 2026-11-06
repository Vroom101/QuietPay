// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {MockAuthToken} from "./mocks/MockAuthToken.sol";
import {FeeOnTransferAuthToken, BlockableAuthToken} from "./mocks/BadTokens.sol";

/// Hardening tests from the independent review: rollback integrity, signature encodings, balance-delta,
/// refund-signer rotation, payout changes and refund limits.
contract PaymentRouterHardeningTest is Test {
    PaymentRouter router;
    MockAuthToken usdt;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address attacker = makeAddr("attacker");
    address payout = makeAddr("payout");
    address newPayout = makeAddr("newPayout");

    uint256 payerPk = 0xA11CE;
    uint256 refundPk = 0xBEEF;
    uint256 newRefundPk = 0xCAFE;
    address payer;
    address refundSigner;

    bytes32 constant MERCHANT = keccak256("merchant-1");
    bytes32 constant ORDER = keccak256("order-1");
    uint256 constant PRICE = 25_000_000;
    uint256 constant FEE = 50_000;

    uint256 vA;
    uint256 vB;

    function _deploy(MockAuthToken t) internal {
        usdt = t;
        router = new PaymentRouter(address(usdt), owner);
        vm.startPrank(owner);
        router.registerMerchant(MERCHANT, payout, refundSigner, 100_000);
        router.setRelayer(relayer, true);
        vm.stopPrank();
        usdt.mint(payer, 1_000_000_000);
        usdt.mint(refundSigner, 1_000_000_000);
    }

    function setUp() public {
        vm.warp(1_000_000);
        payer = vm.addr(payerPk);
        refundSigner = vm.addr(refundPk);
        vA = block.timestamp - 1;
        vB = block.timestamp + 5 minutes;
        _deploy(new MockAuthToken());
    }

    // ------------------------------------------------------------ helpers

    function _sign(uint256 pk, address from, uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(usdt.RECEIVE_TYPEHASH(), from, address(router), value, vA, vB, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdt.DOMAIN_SEPARATOR(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function _paySig() internal view returns (bytes memory) {
        return _sign(payerPk, payer, PRICE, router.computeNonce(MERCHANT, ORDER, payout, PRICE, FEE));
    }

    function _pay() internal {
        bytes memory sig = _paySig();
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, sig);
    }

    function _refundSig(uint256 pk, address signer, uint256 amount, uint256 index) internal view returns (bytes memory) {
        return _sign(pk, signer, amount, router.computeRefundNonce(MERCHANT, ORDER, payer, amount, index));
    }

    function _refund(uint256 pk, address signer, uint256 amount, uint256 index) internal {
        bytes memory sig = _refundSig(pk, signer, amount, index);
        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, amount, vA, vB, sig);
    }

    function _authUnused() internal view returns (bool) {
        return !usdt.authorizationState(payer, router.computeNonce(MERCHANT, ORDER, payout, PRICE, FEE));
    }

    // ------------------------------------------------------------ Task 5.1/5.2: rollback

    function test_failingPayoutTransferRollsEverythingBack() public {
        BlockableAuthToken t = new BlockableAuthToken();
        _deploy(t);
        t.setBlocked(payout);
        bytes memory sig = _paySig();
        vm.prank(relayer);
        vm.expectRevert(bytes("recipient blocked"));
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, sig);

        assertFalse(router.receipts(MERCHANT, ORDER).settled, "receipt stays unset");
        assertTrue(_authUnused(), "authorization is still unused");
        assertEq(t.balanceOf(payer), 1_000_000_000, "payer funds untouched");
        assertEq(t.balanceOf(address(router)), 0);

        t.setBlocked(address(0)); // corrected retry with the same signature
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, sig);
        assertTrue(router.receipts(MERCHANT, ORDER).settled);
        assertEq(t.balanceOf(payout), PRICE - FEE);
    }

    function test_failingFeeTransferRollsEverythingBack() public {
        BlockableAuthToken t = new BlockableAuthToken();
        _deploy(t);
        t.setBlocked(relayer);
        bytes memory sig = _paySig();
        vm.prank(relayer);
        vm.expectRevert(bytes("recipient blocked"));
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, sig);

        assertFalse(router.receipts(MERCHANT, ORDER).settled);
        assertTrue(_authUnused());
        assertEq(t.balanceOf(payout), 0, "the payout leg was rolled back too");
        assertEq(t.balanceOf(payer), 1_000_000_000);

        t.setBlocked(address(0));
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, sig);
        assertEq(t.balanceOf(relayer), FEE);
    }

    function test_failingRefundPayoutRollsEverythingBack() public {
        BlockableAuthToken t = new BlockableAuthToken();
        _deploy(t);
        _pay();
        t.setBlocked(payer);
        bytes memory sig = _refundSig(refundPk, refundSigner, 5_000_000, 0);
        vm.prank(relayer);
        vm.expectRevert(bytes("recipient blocked"));
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);

        PaymentRouter.Receipt memory r = router.receipts(MERCHANT, ORDER);
        assertEq(r.totalRefunded, 0);
        assertEq(r.refundCount, 0);
        assertFalse(
            t.authorizationState(refundSigner, router.computeRefundNonce(MERCHANT, ORDER, payer, 5_000_000, 0)),
            "refund authorization unused"
        );
        assertEq(t.balanceOf(refundSigner), 1_000_000_000);

        t.setBlocked(address(0));
        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);
        assertEq(router.receipts(MERCHANT, ORDER).totalRefunded, 5_000_000);
    }

    // ------------------------------------------------------------ Task 4: balance delta

    function test_feeOnTransferTokenIsRefusedOnPay() public {
        FeeOnTransferAuthToken t = new FeeOnTransferAuthToken();
        _deploy(t);
        bytes memory sig = _paySig();
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.TokenAmountMismatch.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, sig);
        assertFalse(router.receipts(MERCHANT, ORDER).settled);
        assertEq(t.balanceOf(payer), 1_000_000_000, "everything rolled back");
    }

    function test_feeOnTransferTokenIsRefusedOnRefund() public {
        FeeOnTransferAuthToken t = new FeeOnTransferAuthToken();
        _deploy(t);
        t.setLossy(false); // settle the payment while the token behaves
        _pay();
        t.setLossy(true); // then the token starts skimming transfers
        bytes memory sig = _refundSig(refundPk, refundSigner, 5_000_000, 0);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.TokenAmountMismatch.selector);
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);
        PaymentRouter.Receipt memory r = router.receipts(MERCHANT, ORDER);
        assertEq(r.totalRefunded, 0);
        assertEq(r.refundCount, 0);
        assertEq(t.balanceOf(refundSigner), 1_000_000_000, "refund signer funds untouched");
    }

    // ------------------------------------------------------------ Task 5.3: signature encodings

    function _callPay(bytes memory sig) internal returns (bool ok, bytes memory ret) {
        vm.prank(relayer);
        (ok, ret) = address(router).call(
            abi.encodeCall(router.pay, (MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, sig))
        );
    }

    function _selector(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length >= 4) {
            assembly {
                sel := mload(add(ret, 32))
            }
        }
    }

    function test_malformedSignatureLengthsRevertCleanly() public {
        bytes[4] memory bad = [bytes(""), hex"aa", new bytes(64), new bytes(66)];
        for (uint256 i = 0; i < bad.length; i++) {
            (bool ok, bytes memory ret) = _callPay(bad[i]);
            assertFalse(ok);
            assertEq(_selector(ret), PaymentRouter.BadSignatureLength.selector);
        }
    }

    function testFuzz_random65ByteSignaturesRevertWithoutPanics(bytes32 a, bytes32 b, uint8 v) public {
        bytes memory sig = abi.encodePacked(a, b, v);
        (bool ok, bytes memory ret) = _callPay(sig);
        assertFalse(ok);
        assertTrue(_selector(ret) != bytes4(0x4e487b71), "no Panic(uint256)");
        assertFalse(router.receipts(MERCHANT, ORDER).settled);
    }

    function test_allZeroAnd65ByteGarbageSignaturesRevert() public {
        (bool ok1,) = _callPay(new bytes(65));
        assertFalse(ok1);
        (bool ok2,) = _callPay(abi.encodePacked(bytes32(type(uint256).max), bytes32(type(uint256).max), uint8(27)));
        assertFalse(ok2);
    }

    // ------------------------------------------------------------ Task 5.4: payout change

    function test_oldSignatureFailsAfterSetPayoutAndNewOneSucceeds() public {
        bytes memory oldSig = _paySig();
        vm.prank(owner);
        router.setPayout(MERCHANT, newPayout);

        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, oldSig);

        bytes memory newSig =
            _sign(payerPk, payer, PRICE, router.computeNonce(MERCHANT, ORDER, newPayout, PRICE, FEE));
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, newSig);
        assertEq(usdt.balanceOf(newPayout), PRICE - FEE);
        assertEq(usdt.balanceOf(payout), 0);
        assertEq(router.receipts(MERCHANT, ORDER).payout, newPayout);
    }

    // ------------------------------------------------------------ Task 5.5: refund limits

    function test_severalPartialRefundsThenOneOverLimitReverts() public {
        _pay();
        _refund(refundPk, refundSigner, 8_000_000, 0);
        _refund(refundPk, refundSigner, 8_000_000, 1);
        _refund(refundPk, refundSigner, 8_000_000, 2); // 24.00 of 25.00 refunded
        assertEq(router.receipts(MERCHANT, ORDER).totalRefunded, 24_000_000);

        bytes memory over = _refundSig(refundPk, refundSigner, 1_000_001, 3);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.RefundOverValue.selector);
        router.refund(MERCHANT, ORDER, 1_000_001, vA, vB, over);

        PaymentRouter.Receipt memory r = router.receipts(MERCHANT, ORDER);
        assertEq(r.totalRefunded, 24_000_000);
        assertEq(r.refundCount, 3);
        _refund(refundPk, refundSigner, 1_000_000, 3); // the exact remainder still works
        assertEq(router.receipts(MERCHANT, ORDER).totalRefunded, PRICE);
    }

    // ------------------------------------------------------------ Task 3: refund signer rotation

    function test_ownerRotatesRefundSignerAndOldSignerStopsWorking() public {
        _pay();
        _refund(refundPk, refundSigner, 5_000_000, 0);
        PaymentRouter.Receipt memory before_ = router.receipts(MERCHANT, ORDER);
        address newSigner = vm.addr(newRefundPk);
        usdt.mint(newSigner, 100_000_000);

        vm.expectEmit(true, false, false, true, address(router));
        emit PaymentRouter.RefundSignerChanged(MERCHANT, refundSigner, newSigner);
        vm.prank(owner);
        router.setRefundSigner(MERCHANT, newSigner);

        // Receipts and totals are unchanged by rotation.
        PaymentRouter.Receipt memory after_ = router.receipts(MERCHANT, ORDER);
        assertEq(after_.totalRefunded, before_.totalRefunded);
        assertEq(after_.refundCount, before_.refundCount);
        assertTrue(after_.settled);

        // The old signer's authorization no longer works.
        bytes memory oldSig = _refundSig(refundPk, refundSigner, 1_000_000, 1);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.refund(MERCHANT, ORDER, 1_000_000, vA, vB, oldSig);

        // The new signer's does, and funds come from the new signer.
        uint256 newBefore = usdt.balanceOf(newSigner);
        _refund(newRefundPk, newSigner, 1_000_000, 1);
        assertEq(usdt.balanceOf(newSigner), newBefore - 1_000_000);
        assertEq(router.receipts(MERCHANT, ORDER).totalRefunded, 6_000_000);
    }

    function test_onlyOwnerCanRotateAndZeroAddressIsRejected() public {
        vm.prank(attacker);
        vm.expectRevert();
        router.setRefundSigner(MERCHANT, attacker);

        vm.prank(relayer);
        vm.expectRevert();
        router.setRefundSigner(MERCHANT, relayer);

        vm.startPrank(owner);
        vm.expectRevert(PaymentRouter.ZeroAddress.selector);
        router.setRefundSigner(MERCHANT, address(0));
        vm.expectRevert(PaymentRouter.UnknownMerchant.selector);
        router.setRefundSigner(keccak256("nobody"), attacker);
        vm.stopPrank();
    }
}
