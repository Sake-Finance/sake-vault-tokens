// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { SakeATokenVault } from "./../../tokens/SakeATokenVault.sol";


/// @title MockSakeATokenVault
/// @author Sake Finance
/// @notice A mock implementation of the SakeATokenVault contract. Used to test proxy upgrades.
contract MockSakeATokenVault is SakeATokenVault {
    
    event AddedEvent();

    constructor(
        address underlying_,
        address atoken_,
        address sakePool_,
        uint16 referralCode_
    ) SakeATokenVault(underlying_, atoken_, sakePool_, referralCode_) {}

    function addedFunction() external {
        emit AddedEvent();
    }
}
