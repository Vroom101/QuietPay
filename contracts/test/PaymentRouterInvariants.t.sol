// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {MockAuthToken} from "./mocks/MockAuthToken.sol";

/// Drives random payments, refunds and stray direct transfers through the router.
contract RouterHandler is Test {
    PaymentRouter public router;
    MockAuthToken public usdt;
    address public relayer;
    address public payout;
    uint256 public payerPk = 0xA11CE;
    uint256 public refundPk = 0xBEEF;
    bytes32 public constant MERCHANT = keccak256("merchant-1");
    uint256 public constant N = 8;

    uint256 public donated; // tokens sent straight to the router, which it must never spend or lose
    uint256 public paidCount;
    uint256 public refundedCount;
    uint256 public totalFees;

    constructor(PaymentRouter r, MockAuthToken t, address relayer_, address payout_) {
        router = r;
        usdt = t;
        relayer = relayer_;
        payout = payout_;
    }

    function _sign(uint256 pk, address from, uint256 value, bytes32 nonce, uint256 a, uint256 b)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(usdt.RECEIVE_TYPEHASH(), from, address(router), value, a, b, nonce));
        (uint8 v, bytes32 r_, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdt.DOMAIN_SEPARATOR(), sh)));
        return abi.encodePacked(r_, s, v);
    }

    function pay(uint256 orderSeed, uint256 value, uint256 fee) external {
        bytes32 orderId = bytes32(orderSeed % N + 1);
        value = bound(value, 1, 1_000_000_000);
        fee = bound(fee, 0, 100_000);
        address payer = vm.addr(payerPk);
        uint256 a = block.timestamp - 1;
        uint256 b = block.timestamp + 5 minutes;
        bytes memory sig =
            _sign(payerPk, payer, value, router.computeNonce(MERCHANT, orderId, payout, value, fee), a, b);
        vm.prank(relayer);
        try router.pay(MERCHANT, orderId, payer, value, fee, a, b, sig) {
            paidCount++;
            totalFees += fee;
        } catch {}
    }

    function refund(uint256 orderSeed, uint256 amount) external {
        bytes32 orderId = bytes32(orderSeed % N + 1);
        PaymentRouter.Receipt memory rc = router.receipts(MERCHANT, orderId);
        if (rc.payer == address(0)) return;
        amount = bound(amount, 1, rc.value);
        uint256 a = block.timestamp - 1;
        uint256 b = block.timestamp + 5 minutes;
        address signer = vm.addr(refundPk);
        bytes memory sig = _sign(
            refundPk,
            signer,
            amount,
            router.computeRefundNonce(MERCHANT, orderId, rc.payer, amount, rc.refundCount),
            a,
            b
        );
        vm.prank(relayer);
        try router.refund(MERCHANT, orderId, amount, a, b, sig) {
            refundedCount++;
        } catch {}
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000);
        usdt.mint(address(this), amount);
        usdt.transfer(address(router), amount);
        donated += amount;
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 2 hours));
    }

    function orderId(uint256 i) external pure returns (bytes32) {
        return bytes32(i + 1);
    }
}

contract PaymentRouterInvariantTest is Test {
    PaymentRouter router;
    MockAuthToken usdt;
    RouterHandler handler;
    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address payout = makeAddr("payout");

    function setUp() public {
        vm.warp(1_000_000);
        usdt = new MockAuthToken();
        router = new PaymentRouter(address(usdt), owner);
        address payer = vm.addr(0xA11CE);
        address refundSigner = vm.addr(0xBEEF);
        vm.startPrank(owner);
        router.registerMerchant(keccak256("merchant-1"), payout, refundSigner, 100_000);
        router.setRelayer(relayer, true);
        vm.stopPrank();
        usdt.mint(payer, type(uint128).max);
        usdt.mint(refundSigner, type(uint128).max);
        handler = new RouterHandler(router, usdt, relayer, payout);
        targetContract(address(handler));
    }

    /// The router never keeps user funds: its balance is exactly what strangers donated.
    function invariant_routerHoldsOnlyDonations() public view {
        assertEq(usdt.balanceOf(address(router)), handler.donated());
    }

    function invariant_receiptsAreConsistent() public view {
        for (uint256 i = 0; i < handler.N(); i++) {
            PaymentRouter.Receipt memory rc = router.receipts(keccak256("merchant-1"), handler.orderId(i));
            assertLe(rc.totalRefunded, rc.value);
            if (rc.payer != address(0)) assertGt(rc.value, 0);
        }
    }

    /// Fees paid out to the relayer equal the sum of the fees of accepted payments; the relayer gets nothing else.
    function invariant_relayerEarnsOnlyFees() public view {
        assertEq(usdt.balanceOf(relayer), handler.totalFees());
    }

    /// Guards against a vacuous invariant run: the handler's pay and refund really succeed.
    function test_handlerActionsReallySettle() public {
        handler.pay(0, 5_000_000, 50_000);
        assertEq(handler.paidCount(), 1);
        assertEq(usdt.balanceOf(payout), 4_950_000);
        handler.refund(0, 1_000_000);
        assertEq(handler.refundedCount(), 1);
        assertEq(usdt.balanceOf(address(router)), 0);
    }
}
