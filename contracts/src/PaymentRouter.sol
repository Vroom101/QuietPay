// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Subset of EIP-3009 used by the router. transferWithAuthorization is never called.
interface IReceiveWithAuthorization {
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
    ) external;
}

/// @title Quietpay PaymentRouter
/// @notice Settles a USDT checkout from a single payer signature (EIP-3009
///         ReceiveWithAuthorization). Only allowlisted relayers submit; the payer
///         never sends a transaction or holds gas. Not upgradeable.
contract PaymentRouter is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAY_TAG = keccak256("quietpay.pay.v2");
    bytes32 public constant REFUND_TAG = keccak256("quietpay.refund.v1");
    uint256 public constant MAX_WINDOW = 10 minutes;

    struct Merchant {
        address payout;
        address refundSigner;
        uint256 maxRelayFee;
    }

    struct Receipt {
        address payer;
        address payout;
        address relayer;
        uint256 value;
        uint256 fee;
        uint64 paidAt;
        bool settled;
        uint32 refundCount;
        uint256 totalRefunded;
    }

    IERC20 public immutable token;

    mapping(bytes32 merchantId => Merchant) public merchants;
    mapping(address relayer => bool) public isRelayer;
    mapping(bytes32 merchantId => mapping(bytes32 orderId => Receipt)) private _receipts;

    event MerchantRegistered(bytes32 indexed merchantId, address payout, address refundSigner, uint256 maxRelayFee);
    event PayoutChanged(bytes32 indexed merchantId, address payout);
    event RefundSignerChanged(bytes32 indexed merchantId, address oldSigner, address newSigner);
    event RelayerSet(address indexed relayer, bool allowed);
    event Paid(
        bytes32 indexed merchantId,
        bytes32 indexed orderId,
        address indexed payer,
        address payout,
        uint256 value,
        uint256 fee,
        address relayer
    );
    event Refunded(
        bytes32 indexed merchantId,
        bytes32 indexed orderId,
        address indexed payer,
        uint256 amount,
        uint256 totalRefunded,
        uint256 refundIndex
    );

    error NotRelayer();
    error UnknownMerchant();
    error MerchantExists();
    error ZeroAddress();
    error ZeroValue();
    error FeeOverCap();
    error BadWindow();
    error NotYetValid();
    error Expired();
    error AlreadySettled();
    error BadSignatureLength();
    error NoReceipt();
    error RefundOverValue();
    error TokenAmountMismatch();

    constructor(address token_, address owner_) Ownable(owner_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
    }

    // ---------------------------------------------------------------- owner

    function registerMerchant(bytes32 merchantId, address payout, address refundSigner, uint256 maxRelayFee)
        external
        onlyOwner
    {
        if (payout == address(0) || refundSigner == address(0)) revert ZeroAddress();
        if (merchants[merchantId].payout != address(0)) revert MerchantExists();
        merchants[merchantId] = Merchant(payout, refundSigner, maxRelayFee);
        emit MerchantRegistered(merchantId, payout, refundSigner, maxRelayFee);
    }

    function setPayout(bytes32 merchantId, address payout) external onlyOwner {
        if (merchants[merchantId].payout == address(0)) revert UnknownMerchant();
        if (payout == address(0)) revert ZeroAddress();
        merchants[merchantId].payout = payout;
        emit PayoutChanged(merchantId, payout);
    }

    /// @notice Rotates a merchant's refund signer. Policy: the registry is operator-controlled in this MVP, so only
    ///         the owner may call this (a merchant asks the operator). Existing receipts and totalRefunded are
    ///         unchanged; authorizations signed by the old signer stop working because `refund` always pulls from
    ///         the registry's current signer.
    function setRefundSigner(bytes32 merchantId, address newSigner) external onlyOwner {
        Merchant storage m = merchants[merchantId];
        if (m.payout == address(0)) revert UnknownMerchant();
        if (newSigner == address(0)) revert ZeroAddress();
        address old = m.refundSigner;
        m.refundSigner = newSigner;
        emit RefundSignerChanged(merchantId, old, newSigner);
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        isRelayer[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------- views

    function receipts(bytes32 merchantId, bytes32 orderId) external view returns (Receipt memory) {
        return _receipts[merchantId][orderId];
    }

    /// @notice The EIP-3009 nonce the payer must sign for this order. Bound to the merchant, order,
    ///         payout, value AND relay fee: changing the registry payout, or submitting a different fee
    ///         than the payer saw, produces a different nonce and the token rejects the signature.
    function computeNonce(bytes32 merchantId, bytes32 orderId, address payout, uint256 value, uint256 fee)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(PAY_TAG, merchantId, orderId, payout, value, fee));
    }

    /// @notice The EIP-3009 nonce the refundSigner must sign for refund number `refundIndex`.
    ///         The payer is read from the receipt by the router, never passed in.
    function computeRefundNonce(
        bytes32 merchantId,
        bytes32 orderId,
        address payer,
        uint256 amount,
        uint256 refundIndex
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(REFUND_TAG, merchantId, orderId, payer, amount, refundIndex));
    }

    // ---------------------------------------------------------------- relayer

    function pay(
        bytes32 merchantId,
        bytes32 orderId,
        address payer,
        uint256 value,
        uint256 fee,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        address payout = _check(merchantId, payer, value, fee, validAfter, validBefore, signature.length);

        Receipt storage r = _receipts[merchantId][orderId];
        if (r.settled) revert AlreadySettled();

        // Effects before interactions: the receipt is written before funds move.
        r.payer = payer;
        r.payout = payout;
        r.relayer = msg.sender;
        r.value = value;
        r.fee = fee;
        r.paidAt = uint64(block.timestamp);
        r.settled = true;

        _pull(computeNonce(merchantId, orderId, payout, value, fee), payer, value, validAfter, validBefore, signature);

        token.safeTransfer(payout, value - fee);
        if (fee > 0) token.safeTransfer(msg.sender, fee);

        emit Paid(merchantId, orderId, payer, payout, value, fee, msg.sender);
    }

    /// @notice Gasless partial refund. The merchant's refundSigner signs a ReceiveWithAuthorization
    ///         for `amount` to this router; the router forwards it to the payer stored in the receipt.
    ///         The relay fee on refunds is zero; the operator absorbs gas.
    function refund(
        bytes32 merchantId,
        bytes32 orderId,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata signature
    ) external nonReentrant whenNotPaused {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        Receipt storage r = _receipts[merchantId][orderId];
        if (!r.settled) revert NoReceipt();
        if (amount == 0) revert ZeroValue();
        if (r.totalRefunded + amount > r.value) revert RefundOverValue();
        _checkWindow(validAfter, validBefore);
        if (signature.length != 65) revert BadSignatureLength();

        address payer = r.payer;
        uint256 index = r.refundCount;
        // Effects before interactions.
        r.totalRefunded += amount;
        r.refundCount = uint32(index + 1);

        _pull(
            computeRefundNonce(merchantId, orderId, payer, amount, index),
            merchants[merchantId].refundSigner,
            amount,
            validAfter,
            validBefore,
            signature
        );
        token.safeTransfer(payer, amount);

        emit Refunded(merchantId, orderId, payer, amount, r.totalRefunded, index);
    }

    /// @dev Validates inputs and returns the merchant's current registry payout.
    function _check(
        bytes32 merchantId,
        address payer,
        uint256 value,
        uint256 fee,
        uint256 validAfter,
        uint256 validBefore,
        uint256 sigLen
    ) private view returns (address payout) {
        Merchant storage m = merchants[merchantId];
        payout = m.payout;
        if (payout == address(0)) revert UnknownMerchant();
        if (payer == address(0)) revert ZeroAddress();
        if (value == 0) revert ZeroValue();
        if (fee > m.maxRelayFee || fee >= value) revert FeeOverCap();
        _checkWindow(validAfter, validBefore);
        if (sigLen != 65) revert BadSignatureLength();
    }

    function _checkWindow(uint256 validAfter, uint256 validBefore) private view {
        if (validBefore <= validAfter || validBefore - validAfter > MAX_WINDOW) revert BadWindow();
        if (block.timestamp <= validAfter) revert NotYetValid();
        if (block.timestamp >= validBefore) revert Expired();
    }

    /// @dev The only token call besides plain transfers: pull the payer's authorized funds.
    function _pull(
        bytes32 nonce,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata sig
    ) private {
        (bytes32 r, bytes32 s, uint8 v) = _split(sig);
        uint256 before_ = token.balanceOf(address(this));
        IReceiveWithAuthorization(address(token)).receiveWithAuthorization(
            from, address(this), value, validAfter, validBefore, nonce, v, r, s
        );
        // Fee-on-transfer or otherwise lossy tokens would leave the router short; refuse them outright.
        if (token.balanceOf(address(this)) - before_ != value) revert TokenAmountMismatch();
    }

    function _split(bytes calldata sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        r = bytes32(sig[0:32]);
        s = bytes32(sig[32:64]);
        v = uint8(sig[64]);
    }
}
