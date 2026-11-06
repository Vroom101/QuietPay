// Regenerate the JSON: cd contracts; forge build --contracts ../packages/facilitator/test/fixtures -R "@mocks/=test/mocks/" -R "@openzeppelin/=lib/openzeppelin-contracts/" --out <tmp>; keep abi + bytecode.object.
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {MockTransferAuthToken} from "@mocks/MockTransferAuthToken.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
/// @dev TEST-ONLY. The repo mock token cannot cancel; the official EIP-3009 token can. Adds cancelAuthorization +
///      AuthorizationCanceled so the facilitator's cancel handling can be exercised on a real chain. Never deployed.
contract CancelableToken is MockTransferAuthToken {
    bytes32 public constant CANCEL_TYPEHASH = keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(!authorizationState[authorizer][nonce], "auth used");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, authorizer, nonce)));
        require(ECDSA.recover(digest, v, r, s) == authorizer, "invalid signature");
        authorizationState[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }
}
