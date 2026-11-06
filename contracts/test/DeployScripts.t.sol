// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployQualifying} from "../script/DeployQualifying.s.sol";
import {DeployLocal} from "../script/DeployLocal.s.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

contract DeployScriptsTest is Test {
    DeployQualifying q;
    DeployLocal l;
    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address payout = makeAddr("payout");
    address refundSigner = makeAddr("refundSigner");
    bytes32 constant MERCHANT = keccak256("demo-store");

    function setUp() public {
        q = new DeployQualifying();
        l = new DeployLocal();
    }

    /// In a test the script contract itself sends the admin calls, so it is the owner (in a real broadcast the owner key is).
    function _deployTo(address usdt) internal returns (PaymentRouter) {
        return q.deploy(usdt, address(q), relayer, payout, refundSigner, MERCHANT, 100_000);
    }

    function test_qualifyingRevertsOnWrongChainId() public {
        address official = q.OFFICIAL_USDT();
        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSelector(DeployQualifying.WrongChain.selector, 31337));
        _deployTo(official);
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployQualifying.WrongChain.selector, 1));
        _deployTo(official);
        vm.chainId(26251874);
        vm.expectRevert(abi.encodeWithSelector(DeployQualifying.WrongChain.selector, 26251874));
        q.guard(official);
    }

    function test_qualifyingRevertsOnWrongTokenAddress() public {
        vm.chainId(1874);
        address stand = makeAddr("some-other-token");
        vm.expectRevert(abi.encodeWithSelector(DeployQualifying.WrongToken.selector, stand));
        _deployTo(stand);
        vm.expectRevert(abi.encodeWithSelector(DeployQualifying.WrongToken.selector, address(0)));
        _deployTo(address(0));
    }

    function test_qualifyingDeploysWithTheRightPairAndReadsBackTheToken() public {
        vm.chainId(1874);
        // A token with the official token's facts at the official address (test-only; never on a public network).
        address official = q.OFFICIAL_USDT();
        deployCodeTo("MockAuthToken.sol:MockAuthToken", official);
        PaymentRouter r = _deployTo(official);
        assertEq(address(r.token()), official);
        assertEq(r.owner(), address(q));
        assertTrue(r.isRelayer(relayer));
        (address p, address rs, uint256 maxFee) = r.merchants(MERCHANT);
        assertEq(p, payout);
        assertEq(rs, refundSigner);
        assertEq(maxFee, 100_000);
    }

    function test_qualifyingRefusesATokenWhoseFactsDoNotMatch() public {
        vm.chainId(1874);
        address official = q.OFFICIAL_USDT();
        // Right address, no token there: the read-back of name() and decimals() cannot succeed.
        vm.expectRevert();
        _deployTo(official);
    }

    function test_scriptConstantsEqualTheTokenJson() public view {
        string memory json = vm.readFile("../packages/shared/token.json");
        assertEq(vm.parseJsonAddress(json, ".address"), q.OFFICIAL_USDT());
        assertEq(vm.parseJsonUint(json, ".chainId"), q.QUALIFYING_CHAIN_ID());
        assertEq(vm.parseJsonString(json, ".name"), q.TOKEN_NAME());
        assertEq(vm.parseJsonUint(json, ".decimals"), uint256(q.TOKEN_DECIMALS()));
    }

    function test_localScriptRefusesChain1874AndAnyPublicChain() public {
        vm.chainId(1874);
        vm.expectRevert(abi.encodeWithSelector(DeployLocal.NotForPublicNetworks.selector, 1874));
        l.guard();
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployLocal.NotForPublicNetworks.selector, 1));
        l.guard();
        vm.chainId(31337);
        l.guard(); // anvil is fine
    }
}
