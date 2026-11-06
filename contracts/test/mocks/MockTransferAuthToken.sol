// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {MockAuthToken} from "./MockAuthToken.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
/// @dev Test-only extension for direct EIP-3009 API payments; never deployed publicly.
contract MockTransferAuthToken is MockAuthToken {
    bytes32 public constant TRANSFER_TYPEHASH = keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    function transferWithAuthorization(address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp > validAfter, "auth not yet valid");
        require(block.timestamp < validBefore, "auth expired");
        require(!authorizationState[from][nonce], "auth used");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(TRANSFER_TYPEHASH, from, to, value, validAfter, validBefore, nonce)));
        require(ECDSA.recover(digest, v, r, s) == from, "invalid signature");
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}
