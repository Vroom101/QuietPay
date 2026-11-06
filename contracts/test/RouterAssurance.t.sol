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
}
