// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {MockUSDT} from "./MockUSDT.sol";

/// @dev Token that calls back into a contract recipient, like an ERC-777 style hook.
contract HookUSDT is MockUSDT {
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to.code.length > 0 && from != address(0)) {
            (bool ok,) = to.call(abi.encodeWithSignature("onTokenReceived(uint256)", value));
            ok; // a hook failure must not decide the transfer
        }
    }
}

/// @dev A payer contract that tries to re-enter refund() from the token hook.
contract ReentrantPayer {
    PaymentRouter public router;
    bytes32 public merchantId;
    bytes32 public orderId;
    bytes public sig;
    uint256 public vA;
    uint256 public vB;
    bool public armed;
    bool public reenterSucceeded;
    bool public reenterAttempted;

    function arm(PaymentRouter r, bytes32 m, bytes32 o, bytes calldata s, uint256 a, uint256 b) external {
        router = r;
        merchantId = m;
        orderId = o;
        sig = s;
        vA = a;
        vB = b;
        armed = true;
    }

    function onTokenReceived(uint256 amount) external {
        if (!armed || msg.sender == address(0)) return;
        armed = false;
        reenterAttempted = true;
        try router.refund(merchantId, orderId, amount, vA, vB, sig) {
            reenterSucceeded = true;
        } catch {
            reenterSucceeded = false;
        }
    }
}

contract PaymentRouterRefundTest is Test {
    PaymentRouter router;
    MockUSDT usdt;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address attacker = makeAddr("attacker");
    address payout = makeAddr("payout");

    uint256 payerPk = 0xA11CE;
    uint256 refundPk = 0xBEEF;
    address payer;
    address refundSigner;

    bytes32 constant MERCHANT = keccak256("merchant-1");
    bytes32 constant ORDER = keccak256("order-1");
    uint256 constant PRICE = 25_000_000;
    uint256 constant FEE = 50_000;

    uint256 vA;
    uint256 vB;

    function _deploy(MockUSDT t) internal {
        usdt = t;
        router = new PaymentRouter(address(usdt), owner);
        vm.startPrank(owner);
        router.registerMerchant(MERCHANT, payout, refundSigner, 100_000);
        router.setRelayer(relayer, true);
        vm.stopPrank();
    }

    function setUp() public virtual {
        vm.warp(1_000_000);
        payer = vm.addr(payerPk);
        refundSigner = vm.addr(refundPk);
        _deploy(new MockUSDT());
        usdt.mint(payer, 1_000_000_000);
        usdt.mint(refundSigner, 100_000_000);
        vA = block.timestamp - 1;
        vB = block.timestamp + 5 minutes;
        _payOrder(payer, payerPk);
    }

    // ------------------------------------------------------------ helpers

    function _sign(uint256 pk, address from, address to, uint256 value, uint256 a, uint256 b, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(usdt.RECEIVE_TYPEHASH(), from, to, value, a, b, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdt.DOMAIN_SEPARATOR(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _payOrder(address who, uint256 pk) internal {
        bytes32 n = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        bytes memory sig = _sign(pk, who, address(router), PRICE, vA, vB, n);
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, who, PRICE, FEE, vA, vB, sig);
    }

    function _refundSig(address who, uint256 amount, uint256 index) internal view returns (bytes memory) {
        bytes32 n = router.computeRefundNonce(MERCHANT, ORDER, who, amount, index);
        return _sign(refundPk, refundSigner, address(router), amount, vA, vB, n);
    }

    function _refund(uint256 amount, uint256 index) internal {
        bytes memory sig = _refundSig(payer, amount, index);
        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, amount, vA, vB, sig);
    }

    // ------------------------------------------------------------ 1. happy path

    function test_partialRefundPaysStoredPayer() public {
        uint256 payerBefore = usdt.balanceOf(payer);
        uint256 signerBefore = usdt.balanceOf(refundSigner);
        bytes memory sig = _refundSig(payer, 10_000_000, 0);

        vm.expectEmit(true, true, true, true, address(router));
        emit PaymentRouter.Refunded(MERCHANT, ORDER, payer, 10_000_000, 10_000_000, 0);
        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, 10_000_000, vA, vB, sig);

        assertEq(usdt.balanceOf(payer), payerBefore + 10_000_000);
        assertEq(usdt.balanceOf(refundSigner), signerBefore - 10_000_000);
        assertEq(usdt.balanceOf(address(router)), 0, "router custodies nothing");
        assertEq(usdt.balanceOf(relayer), FEE, "no refund fee to the relayer");
        PaymentRouter.Receipt memory r = router.receipts(MERCHANT, ORDER);
        assertEq(r.totalRefunded, 10_000_000);
        assertEq(r.refundCount, 1);
        assertTrue(r.settled);
    }

    // ------------------------------------------------------------ 2. two partials

    function test_twoPartialRefundsUseDifferentNonces() public {
        _refund(5_000_000, 0);
        // Same amount again: only the index differs, so the nonce differs and it succeeds.
        _refund(5_000_000, 1);
        PaymentRouter.Receipt memory r = router.receipts(MERCHANT, ORDER);
        assertEq(r.totalRefunded, 10_000_000);
        assertEq(r.refundCount, 2);
        assertTrue(
            router.computeRefundNonce(MERCHANT, ORDER, payer, 5_000_000, 0)
                != router.computeRefundNonce(MERCHANT, ORDER, payer, 5_000_000, 1)
        );
    }

    // ------------------------------------------------------------ 3. full refund

    function test_fullRefundEndsAtExactlyValuePaid() public {
        _refund(10_000_000, 0);
        _refund(10_000_000, 1);
        _refund(5_000_000, 2);
        assertEq(router.receipts(MERCHANT, ORDER).totalRefunded, PRICE);

        bytes memory sig = _refundSig(payer, 1, 3);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.RefundOverValue.selector);
        router.refund(MERCHANT, ORDER, 1, vA, vB, sig);
    }

    // ------------------------------------------------------------ 4. over-refund

    function test_overRefundReverts() public {
        bytes memory sig = _refundSig(payer, PRICE + 1, 0);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.RefundOverValue.selector);
        router.refund(MERCHANT, ORDER, PRICE + 1, vA, vB, sig);
    }

    function test_refundIsComparedToGrossValueNotNet() public {
        // Gross value 25.00 is refundable even though the merchant received 24.95.
        _refund(PRICE, 0);
        assertEq(router.receipts(MERCHANT, ORDER).totalRefunded, PRICE);
    }

    // ------------------------------------------------------------ 5. zero

    function test_zeroAmountReverts() public {
        bytes memory sig = _refundSig(payer, 0, 0);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.ZeroValue.selector);
        router.refund(MERCHANT, ORDER, 0, vA, vB, sig);
    }

    // ------------------------------------------------------------ 6. relayers only

    function test_nonRelayerCannotRefund() public {
        bytes memory sig = _refundSig(payer, 1_000_000, 0);
        vm.prank(attacker);
        vm.expectRevert(PaymentRouter.NotRelayer.selector);
        router.refund(MERCHANT, ORDER, 1_000_000, vA, vB, sig);
    }

    // ------------------------------------------------------------ 7. unknown order

    function test_unknownOrderReverts() public {
        bytes memory sig = _refundSig(payer, 1_000_000, 0);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.NoReceipt.selector);
        router.refund(MERCHANT, keccak256("nope"), 1_000_000, vA, vB, sig);
    }

    // ------------------------------------------------------------ 8. replay

    function test_replayOfSameSignedRefundReverts() public {
        bytes memory sig = _refundSig(payer, 5_000_000, 0);
        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);

        // Same signature again: the index has moved on, so the nonce no longer matches.
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);
        assertEq(router.receipts(MERCHANT, ORDER).totalRefunded, 5_000_000);
    }

    function test_signatureForLaterIndexCannotBeUsedEarly() public {
        bytes memory sigIndex1 = _refundSig(payer, 5_000_000, 1);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sigIndex1);
    }

    // ------------------------------------------------------------ 9. binding

    function test_signatureNamingDifferentPayerDoesNotVerify() public {
        bytes memory sig = _refundSig(attacker, 5_000_000, 0);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);
    }

    function test_signatureNamingDifferentAmountDoesNotVerify() public {
        bytes memory sig = _refundSig(payer, 5_000_000, 0);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.refund(MERCHANT, ORDER, 5_000_001, vA, vB, sig);
    }

    function test_signatureNamingDifferentOrderDoesNotVerify() public {
        // A second settled order; a signature made for ORDER cannot refund ORDER2.
        bytes32 order2 = keccak256("order-2");
        bytes32 n = router.computeNonce(MERCHANT, order2, payout, PRICE);
        bytes memory paySig = _sign(payerPk, payer, address(router), PRICE, vA, vB, n);
        vm.prank(relayer);
        router.pay(MERCHANT, order2, payer, PRICE, FEE, vA, vB, paySig);

        bytes memory sig = _refundSig(payer, 5_000_000, 0);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.refund(MERCHANT, order2, 5_000_000, vA, vB, sig);
    }

    // ------------------------------------------------------------ 10. wrong signer

    function test_signatureFromAnyoneButRefundSignerReverts() public {
        bytes32 n = router.computeRefundNonce(MERCHANT, ORDER, payer, 5_000_000, 0);
        bytes memory sig = _sign(0xBAD, vm.addr(0xBAD), address(router), 5_000_000, vA, vB, n);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);

        // The payout wallet, even if it could sign, is not the refundSigner.
        bytes memory sig2 = _sign(payerPk, payer, address(router), 5_000_000, vA, vB, n);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig2);
    }

    // ------------------------------------------------------------ 11. low balance

    function test_refundSignerWithTooLittleUsdtRevertsAndLeavesReceiptUnchanged() public {
        uint256 bal = usdt.balanceOf(refundSigner);
        vm.prank(refundSigner);
        usdt.transfer(attacker, bal - 1_000_000); // leaves 1.00 USDT

        PaymentRouter.Receipt memory before_ = router.receipts(MERCHANT, ORDER);
        bytes memory sig = _refundSig(payer, 5_000_000, 0);
        vm.prank(relayer);
        vm.expectRevert();
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);

        PaymentRouter.Receipt memory after_ = router.receipts(MERCHANT, ORDER);
        assertEq(after_.totalRefunded, before_.totalRefunded);
        assertEq(after_.refundCount, before_.refundCount);
        assertEq(usdt.balanceOf(refundSigner), 1_000_000);
        // The authorization was not consumed, so it works once the wallet is topped up.
        usdt.mint(refundSigner, 10_000_000);
        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);
    }

    // ------------------------------------------------------------ 12. windows

    function test_expiredWindowReverts() public {
        bytes memory sig = _refundSig(payer, 1_000_000, 0);
        vm.warp(vB);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.Expired.selector);
        router.refund(MERCHANT, ORDER, 1_000_000, vA, vB, sig);
    }

    function test_notYetValidWindowReverts() public {
        uint256 a = block.timestamp + 60;
        uint256 b = a + 5 minutes;
        bytes32 n = router.computeRefundNonce(MERCHANT, ORDER, payer, 1_000_000, 0);
        bytes memory sig = _sign(refundPk, refundSigner, address(router), 1_000_000, a, b, n);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.NotYetValid.selector);
        router.refund(MERCHANT, ORDER, 1_000_000, a, b, sig);
    }

    function test_windowLongerThanTenMinutesReverts() public {
        uint256 b = vA + 10 minutes + 1;
        bytes32 n = router.computeRefundNonce(MERCHANT, ORDER, payer, 1_000_000, 0);
        bytes memory sig = _sign(refundPk, refundSigner, address(router), 1_000_000, vA, b, n);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.BadWindow.selector);
        router.refund(MERCHANT, ORDER, 1_000_000, vA, b, sig);
    }

    // ------------------------------------------------------------ 13. pause

    function test_pausedRouterRevertsRefund() public {
        bytes memory sig = _refundSig(payer, 1_000_000, 0);
        vm.prank(owner);
        router.pause();
        vm.prank(relayer);
        vm.expectRevert();
        router.refund(MERCHANT, ORDER, 1_000_000, vA, vB, sig);
        vm.prank(owner);
        router.unpause();
        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, 1_000_000, vA, vB, sig);
    }

    // ------------------------------------------------------------ 14. settled stays settled

    function test_secondPayAfterFullRefundStillReverts() public {
        _refund(PRICE, 0);
        assertTrue(router.receipts(MERCHANT, ORDER).settled);

        bytes32 n = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        uint256 b2 = block.timestamp + 6 minutes;
        bytes memory sig = _sign(payerPk, payer, address(router), PRICE, vA, b2, n);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.AlreadySettled.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, b2, sig);
    }

    /// @dev Pinned against packages/shared computeRefundNonce so on-chain and TS agree.
    function test_refundNonceMatchesSharedTypeScriptBuilder() public view {
        bytes32 n = router.computeRefundNonce(
            bytes32(hex"0101010101010101010101010101010101010101010101010101010101010101"),
            bytes32(hex"0202020202020202020202020202020202020202020202020202020202020202"),
            0x3333333333333333333333333333333333333333,
            5_000_000,
            0
        );
        assertEq(n, 0x714ed318025e3e52735fc272c242c144d0bf97a60518adfe2f729adb50b29d66);
    }

    // ------------------------------------------------------------ registry interaction

    function test_refundSignerIsPerMerchant() public {
        // Each merchant has its own refundSigner; another merchant's signer cannot refund this order.
        bytes32 m2 = keccak256("merchant-2");
        uint256 otherPk = 0xCAFE;
        vm.prank(owner);
        router.registerMerchant(m2, payout, vm.addr(otherPk), 100_000);
        bytes32 n = router.computeNonce(m2, ORDER, payout, PRICE);
        bytes memory paySig = _sign(payerPk, payer, address(router), PRICE, vA, vB, n);
        vm.prank(relayer);
        router.pay(m2, ORDER, payer, PRICE, FEE, vA, vB, paySig);

        usdt.mint(vm.addr(otherPk), 50_000_000);
        bytes32 rn = router.computeRefundNonce(m2, ORDER, payer, 1_000_000, 0);
        // refundSigner of merchant-1 cannot refund merchant-2's order.
        bytes memory wrong = _sign(refundPk, refundSigner, address(router), 1_000_000, vA, vB, rn);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.refund(m2, ORDER, 1_000_000, vA, vB, wrong);
        bytes memory right = _sign(otherPk, vm.addr(otherPk), address(router), 1_000_000, vA, vB, rn);
        vm.prank(relayer);
        router.refund(m2, ORDER, 1_000_000, vA, vB, right);
    }

    function testFuzz_refundsNeverExceedValuePaid(uint256 a1, uint256 a2) public {
        a1 = bound(a1, 1, PRICE);
        a2 = bound(a2, 1, PRICE);
        _refund(a1, 0);
        bytes memory sig = _refundSig(payer, a2, 1);
        vm.prank(relayer);
        if (a1 + a2 > PRICE) {
            vm.expectRevert(PaymentRouter.RefundOverValue.selector);
            router.refund(MERCHANT, ORDER, a2, vA, vB, sig);
            assertEq(router.receipts(MERCHANT, ORDER).totalRefunded, a1);
        } else {
            router.refund(MERCHANT, ORDER, a2, vA, vB, sig);
            assertEq(router.receipts(MERCHANT, ORDER).totalRefunded, a1 + a2);
        }
    }

    // ------------------------------------------------------------ 15. reentrancy

    /// A contract payer receives the refund and tries to refund again from the token hook.
    /// It is allowlisted as a relayer, so only the reentrancy guard can stop the nested call.
    function test_refundToReentrantPayerCannotReenter() public {
        _deploy(new HookUSDT()); // fresh router and hooked token; the order below is new here
        usdt.mint(refundSigner, 100_000_000);

        // The mock verifies signatures with ecrecover only, so the payer pays as an EOA key and is then
        // turned into the hook contract at the same address. The receipt keeps that address as payer.
        address payerContract = vm.addr(payerPk);
        usdt.mint(payerContract, 100_000_000);
        _payOrder(payerContract, payerPk);
        vm.etch(payerContract, address(new ReentrantPayer()).code);
        vm.prank(owner);
        router.setRelayer(payerContract, true);

        bytes memory sig = _refundSig(payerContract, 5_000_000, 0);
        bytes memory sig2 = _refundSig(payerContract, 5_000_000, 1); // the would-be nested refund
        ReentrantPayer(payerContract).arm(router, MERCHANT, ORDER, sig2, vA, vB);

        vm.prank(relayer);
        router.refund(MERCHANT, ORDER, 5_000_000, vA, vB, sig);

        assertTrue(ReentrantPayer(payerContract).reenterAttempted(), "hook ran");
        assertFalse(ReentrantPayer(payerContract).reenterSucceeded(), "re-entry was blocked");
        PaymentRouter.Receipt memory r = router.receipts(MERCHANT, ORDER);
        assertEq(r.totalRefunded, 5_000_000);
        assertEq(r.refundCount, 1);
    }
}
