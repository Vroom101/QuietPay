// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Quietpay Demo USDT
/// @notice TESTNET-ONLY stand-in for USDT, used because the official Whitechain test USDT has no faucet.
///         It is NOT Tether and has no value. Anyone can mint a capped amount for demos. It mirrors the
///         parts of the real token that Quietpay relies on: 6 decimals and EIP-3009
///         `receiveWithAuthorization` (caller must be the payee). On mainnet, point the relayer and
///         router at the real USDT instead; no router code changes.
contract DemoUSDT is ERC20, EIP712 {
    bytes32 public constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    /// @notice Max a single faucet call may mint (1,000 demo USDT).
    uint256 public constant FAUCET_CAP = 1_000 * 1e6;

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("Quietpay Demo USDT", "USDT") EIP712("Quietpay Demo USDT", "1") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Public demo faucet. Mints up to FAUCET_CAP to `to`.
    function faucet(address to, uint256 amount) external {
        require(amount > 0 && amount <= FAUCET_CAP, "faucet: 1 to 1000 USDT per call");
        _mint(to, amount);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(to == msg.sender, "caller must be the payee");
        require(block.timestamp > validAfter, "auth not yet valid");
        require(block.timestamp < validBefore, "auth expired");
        require(!authorizationState[from][nonce], "auth used");
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce)));
        require(ECDSA.recover(digest, v, r, s) == from, "invalid signature");
        authorizationState[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
