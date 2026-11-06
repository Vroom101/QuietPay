// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockAuthToken} from "./MockAuthToken.sol";

/// @dev TEST-ONLY. Takes 1% of every transfer (burned), like a fee-on-transfer token. The router must refuse it.
contract FeeOnTransferAuthToken is MockAuthToken {
    bool public lossy = true;

    function setLossy(bool v) external {
        lossy = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (lossy && from != address(0) && to != address(0)) {
            uint256 cut = value / 100;
            super._update(from, address(0), cut); // burn the cut
            super._update(from, to, value - cut);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev TEST-ONLY. Reverts any transfer to `blocked`, to prove the router rolls back cleanly when a payout leg fails.
contract BlockableAuthToken is MockAuthToken {
    address public blocked;

    function setBlocked(address a) external {
        blocked = a;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(to == address(0) || to != blocked, "recipient blocked");
        super._update(from, to, value);
    }
}
