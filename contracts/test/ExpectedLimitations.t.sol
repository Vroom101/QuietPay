// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {MockAuthToken} from "./mocks/MockAuthToken.sol";

/// TEST-ONLY. Takes 1% on plain transfer() but is lossless on receiveWithAuthorization, like a Tether-style
/// token whose admin switched on a transfer-only fee.
contract TransferFeeToken is MockAuthToken {
    function transfer(address to, uint256 value) public override returns (bool) {
        uint256 cut = value / 100;
        _burn(msg.sender, cut);
        return super.transfer(to, value - cut);
    }
}

/// Findings from the Opus R1/R3 review of the DEPLOYED router that are accepted as limitations (no redeploy: none is
/// Critical or High). Each test pins today's behaviour; if the router is ever redeployed with a fix, flip the asserts.
/// See docs/lead/decisions.md "Router review R1/R3".
contract ExpectedLimitationsTest is Test {
    PaymentRouter router;
    MockAuthToken usdt;
    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address payout = makeAddr("payout");
    uint256 payerPk = 0xA11CE;
    uint256 refundPk = 0xBEEF;
    address payer;
    address refundSigner;
    bytes32 constant MERCHANT = keccak256("merchant-1");
    uint256 vA;
    uint256 vB;

    function _setup(MockAuthToken t) internal {
        usdt = t;
        vm.warp(1_000_000);
        payer = vm.addr(payerPk);
        refundSigner = vm.addr(refundPk);
        vA = block.timestamp - 1;
        vB = block.timestamp + 5 minutes;
        router = new PaymentRouter(address(usdt), owner);
        vm.startPrank(owner);
        router.registerMerchant(MERCHANT, payout, refundSigner, 100_000);
        router.setRelayer(relayer, true);
        vm.stopPrank();
        usdt.mint(payer, 1_000_000_000);
        usdt.mint(refundSigner, 1_000_000_000);
    }

    function _sign(uint256 pk, address from, uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(usdt.RECEIVE_TYPEHASH(), from, address(router), value, vA, vB, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdt.DOMAIN_SEPARATOR(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function _pay(bytes32 orderId, uint256 value, uint256 fee) internal {
        bytes memory sig = _sign(payerPk, payer, value, router.computeNonce(MERCHANT, orderId, payout, value, fee));
        vm.prank(relayer);
        router.pay(MERCHANT, orderId, payer, value, fee, vA, vB, sig);
    }

    /// Finding 1: only the incoming pull is balance-checked. A transfer-only token fee underpays the merchant while
    /// the event and receipt still claim value - fee. Mitigation is off-chain monitoring of the token.
    function test_LIMITATION_transferOnlyTokenFeeUnderpaysMerchantUnnoticed() public {
        _setup(new TransferFeeToken());
        _pay(keccak256("o1"), 10_000_000, 50_000);
        assertLt(usdt.balanceOf(payout), 10_000_000 - 50_000); // merchant got less than the event says
        PaymentRouter.Receipt memory rc = router.receipts(MERCHANT, keccak256("o1"));
        assertEq(rc.value, 10_000_000); // receipt still claims the full amount
    }

    /// Finding 2: plain Ownable. Pause then renounce locks pay and refund forever. Holds no funds.
    function test_LIMITATION_pauseThenRenounceLocksRouterForever() public {
        _setup(new MockAuthToken());
        vm.startPrank(owner);
        router.pause();
        router.renounceOwnership();
        vm.expectRevert();
        router.unpause();
        vm.stopPrank();
        bytes32 o = keccak256("o2");
        bytes memory sig = _sign(payerPk, payer, 5_000_000, router.computeNonce(MERCHANT, o, payout, 5_000_000, 0));
        vm.prank(relayer);
        vm.expectRevert();
        router.pay(MERCHANT, o, payer, 5_000_000, 0, vA, vB, sig);
    }

    /// Finding 3: a zero orderId is a valid id, so a client bug settles it once and then blocks that id for good.
    /// The relayer rejects zero ids off-chain (see docs/lead/shared-change.md).
    function test_LIMITATION_zeroOrderIdIsAccepted() public {
        _setup(new MockAuthToken());
        _pay(bytes32(0), 5_000_000, 0);
        assertEq(router.receipts(MERCHANT, bytes32(0)).value, 5_000_000);
    }
}
