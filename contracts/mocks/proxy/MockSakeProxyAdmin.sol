// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import { SakeProxyAdmin } from "./../../proxy/SakeProxyAdmin.sol";
import { Calls } from "./../../libraries/Calls.sol";


/// @title MockSakeProxyAdmin
/// @author Sake Finance
/// @notice A mock implementation of the SakeProxyAdmin contract. Used to test proxy upgrades.
contract MockSakeProxyAdmin is SakeProxyAdmin {
    
    constructor(address initialOwner) SakeProxyAdmin(initialOwner) {}

    function forwardData(
        address target,
        bytes memory data
    ) external returns (bytes memory result) {
        result = Calls.functionCall(target, data);
    }
}
