// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {MockUSDT} from "./MockUSDT.sol";

contract PaymentRouterTest is Test {
    PaymentRouter router;
    MockUSDT usdt;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address attacker = makeAddr("attacker");
    address payout = makeAddr("payout");
    address refundSigner = makeAddr("refundSigner");

    uint256 payerPk = 0xA11CE;
    address payer;

    bytes32 constant MERCHANT = keccak256("merchant-1");
    bytes32 constant ORDER = keccak256("order-1");
    uint256 constant PRICE = 25_000_000; // 25 USDT, 6 decimals
    uint256 constant FEE = 50_000; // 0.05 USDT
    uint256 constant MAX_FEE = 100_000;

    uint256 validAfter;
    uint256 validBefore;

    function setUp() public {
        vm.warp(1_000_000);
        payer = vm.addr(payerPk);
        usdt = new MockUSDT();
        router = new PaymentRouter(address(usdt), owner);
        vm.startPrank(owner);
        router.registerMerchant(MERCHANT, payout, refundSigner, MAX_FEE);
        router.setRelayer(relayer, true);
        vm.stopPrank();
        usdt.mint(payer, 1_000_000_000);
        validAfter = block.timestamp - 1;
        validBefore = block.timestamp + 5 minutes;
    }

    // ------------------------------------------------------------ helpers

    function _sign(uint256 pk, address from, address to, uint256 value, uint256 vA, uint256 vB, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(usdt.RECEIVE_TYPEHASH(), from, to, value, vA, vB, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdt.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _unpack(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    function _goodSig() internal view returns (bytes memory) {
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        return _sign(payerPk, payer, address(router), PRICE, validAfter, validBefore, nonce);
    }

    function _pay(bytes memory sig) internal {
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    // ------------------------------------------------------------ 1. fee theft

    function test_nonRelayerCannotPay() public {
        bytes memory sig = _goodSig();
        vm.prank(attacker);
        vm.expectRevert(PaymentRouter.NotRelayer.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    function test_attackerCannotPullFundsDirectlyFromToken() public {
        // The token only lets the payee (router) call receiveWithAuthorization.
        bytes memory sig = _goodSig();
        (bytes32 r, bytes32 s, uint8 v) = _unpack(sig);
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        vm.prank(attacker);
        vm.expectRevert(bytes("caller must be the payee"));
        usdt.receiveWithAuthorization(payer, address(router), PRICE, validAfter, validBefore, nonce, v, r, s);
    }

    function test_removedRelayerCannotPay() public {
        bytes memory sig = _goodSig();
        vm.prank(owner);
        router.setRelayer(relayer, false);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.NotRelayer.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    // ------------------------------------------------------------ 2. binding

    function test_wrongPayoutInvalidatesSignature() public {
        bytes32 badNonce = router.computeNonce(MERCHANT, ORDER, attacker, PRICE);
        bytes memory sig = _sign(payerPk, payer, address(router), PRICE, validAfter, validBefore, badNonce);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    function test_payoutChangeAfterSigningReverts() public {
        bytes memory sig = _goodSig();
        vm.prank(owner);
        router.setPayout(MERCHANT, attacker);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    function test_wrongAmountInvalidatesSignature() public {
        bytes memory sig = _goodSig();
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.pay(MERCHANT, ORDER, payer, PRICE + 1, FEE, validAfter, validBefore, sig);
    }

    function test_wrongOrderIdInvalidatesSignature() public {
        bytes memory sig = _goodSig();
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.pay(MERCHANT, keccak256("order-2"), payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    function test_signatureFromWrongSignerReverts() public {
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        bytes memory sig = _sign(0xBAD, payer, address(router), PRICE, validAfter, validBefore, nonce);
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    // ------------------------------------------------------------ 3. replay

    function test_usedAuthorizationCannotBeReplayed() public {
        bytes memory sig = _goodSig();
        _pay(sig);
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        assertTrue(usdt.authorizationState(payer, nonce));

        // Same call again.
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.AlreadySettled.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);

        // Same signature under a new order id: nonce differs, so the signature is invalid.
        vm.prank(relayer);
        vm.expectRevert(bytes("invalid signature"));
        router.pay(MERCHANT, keccak256("order-2"), payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    // ------------------------------------------------------------ 4. settled order

    function test_secondPaymentForSettledOrderReverts() public {
        _pay(_goodSig());
        // Fresh, valid authorization for the same (merchant, order).
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        uint256 vB = block.timestamp + 6 minutes;
        bytes memory sig2 = _sign(payerPk, payer, address(router), PRICE, validAfter, vB, nonce);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.AlreadySettled.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, vB, sig2);
    }

    // ------------------------------------------------------------ 5. fee cap

    function test_feeAboveMaxRelayFeeReverts() public {
        bytes memory sig = _goodSig();
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.FeeOverCap.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, MAX_FEE + 1, validAfter, validBefore, sig);
    }

    function test_feeAtCapSucceeds() public {
        bytes memory sig = _goodSig();
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, PRICE, MAX_FEE, validAfter, validBefore, sig);
        assertEq(usdt.balanceOf(relayer), MAX_FEE);
        assertEq(usdt.balanceOf(payout), PRICE - MAX_FEE);
    }

    // ------------------------------------------------------------ 6. pause

    function test_pausedRouterReverts() public {
        bytes memory sig = _goodSig();
        vm.prank(owner);
        router.pause();
        vm.prank(relayer);
        vm.expectRevert();
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);

        vm.prank(owner);
        router.unpause();
        _pay(sig);
        assertEq(usdt.balanceOf(payout), PRICE - FEE);
    }

    // ------------------------------------------------------------ 7. windows

    function test_expiredWindowReverts() public {
        bytes memory sig = _goodSig();
        vm.warp(validBefore);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.Expired.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    function test_notYetValidWindowReverts() public {
        uint256 vA = block.timestamp + 60;
        uint256 vB = vA + 5 minutes;
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        bytes memory sig = _sign(payerPk, payer, address(router), PRICE, vA, vB, nonce);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.NotYetValid.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, vA, vB, sig);
    }

    function test_windowLongerThanTenMinutesReverts() public {
        uint256 vB = validAfter + 10 minutes + 1;
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        bytes memory sig = _sign(payerPk, payer, address(router), PRICE, validAfter, vB, nonce);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.BadWindow.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, vB, sig);
    }

    function test_windowOfExactlyTenMinutesIsAllowed() public {
        uint256 vB = validAfter + 10 minutes;
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, PRICE);
        bytes memory sig = _sign(payerPk, payer, address(router), PRICE, validAfter, vB, nonce);
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, vB, sig);
        assertTrue(router.receipts(MERCHANT, ORDER).settled);
    }

    // ------------------------------------------------------------ 8. zero value

    function test_zeroValueReverts() public {
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, 0);
        bytes memory sig = _sign(payerPk, payer, address(router), 0, validAfter, validBefore, nonce);
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.ZeroValue.selector);
        router.pay(MERCHANT, ORDER, payer, 0, 0, validAfter, validBefore, sig);
    }

    // ------------------------------------------------------------ 9. end to end

    function test_zeroWbtPayerCompletesPaymentEndToEnd() public {
        assertEq(payer.balance, 0, "payer holds no native gas token");
        bytes memory sig = _goodSig();

        uint256 payerBefore = usdt.balanceOf(payer);
        vm.expectEmit(true, true, true, true, address(router));
        emit PaymentRouter.Paid(MERCHANT, ORDER, payer, payout, PRICE, FEE, relayer);
        _pay(sig);

        // Payer pays exactly the price; merchant gets price - fee; relayer gets the fee.
        assertEq(usdt.balanceOf(payer), payerBefore - PRICE);
        assertEq(usdt.balanceOf(payout), PRICE - FEE);
        assertEq(usdt.balanceOf(relayer), FEE);
        assertEq(usdt.balanceOf(address(router)), 0, "router custodies nothing");
        assertEq(payer.balance, 0, "payer still holds no native gas token");

        PaymentRouter.Receipt memory r = router.receipts(MERCHANT, ORDER);
        assertTrue(r.settled);
        assertEq(r.payer, payer);
        assertEq(r.payout, payout);
        assertEq(r.value, PRICE);
        assertEq(r.fee, FEE);
        assertEq(r.relayer, relayer);
    }

    // ------------------------------------------------------------ registry

    function test_unknownMerchantReverts() public {
        bytes memory sig = _goodSig();
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.UnknownMerchant.selector);
        router.pay(keccak256("nope"), ORDER, payer, PRICE, FEE, validAfter, validBefore, sig);
    }

    function test_onlyOwnerManagesRegistry() public {
        vm.startPrank(attacker);
        vm.expectRevert();
        router.registerMerchant(keccak256("x"), attacker, attacker, 1);
        vm.expectRevert();
        router.setPayout(MERCHANT, attacker);
        vm.expectRevert();
        router.setRelayer(attacker, true);
        vm.expectRevert();
        router.pause();
        vm.stopPrank();
    }

    function test_cannotReRegisterMerchant() public {
        vm.prank(owner);
        vm.expectRevert(PaymentRouter.MerchantExists.selector);
        router.registerMerchant(MERCHANT, attacker, attacker, 1);
    }

    function test_badSignatureLengthReverts() public {
        vm.prank(relayer);
        vm.expectRevert(PaymentRouter.BadSignatureLength.selector);
        router.pay(MERCHANT, ORDER, payer, PRICE, FEE, validAfter, validBefore, hex"1234");
    }

    function testFuzz_feeSplitConservesValue(uint256 value, uint256 fee) public {
        value = bound(value, 1, 500_000_000);
        fee = bound(fee, 0, MAX_FEE);
        vm.assume(fee <= value);
        bytes32 nonce = router.computeNonce(MERCHANT, ORDER, payout, value);
        bytes memory sig = _sign(payerPk, payer, address(router), value, validAfter, validBefore, nonce);
        vm.prank(relayer);
        router.pay(MERCHANT, ORDER, payer, value, fee, validAfter, validBefore, sig);
        assertEq(usdt.balanceOf(payout) + usdt.balanceOf(relayer), value);
        assertEq(usdt.balanceOf(address(router)), 0);
    }
}
