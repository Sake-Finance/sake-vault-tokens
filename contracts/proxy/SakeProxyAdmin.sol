// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import { ITransparentUpgradeableProxy } from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ISakeProxyAdmin } from "./../interfaces/proxy/ISakeProxyAdmin.sol";
import { Ownable2StepWTR } from "./../utils/Ownable2StepWTR.sol";


/// @title SakeProxyAdmin
/// @author Sake Finance
/// @notice An auxiliary contract meant to be assigned as the admin of a TransparentUpgradeableProxy.
///
/// Based on OpenZeppelins's implementation, modified to use Ownable2StepWTR.
contract SakeProxyAdmin is Ownable2StepWTR, ISakeProxyAdmin {
    
    /// @notice Constructs the SakeATokenVault contract.
    /// @param initialOwner The initial owner of the contract.
    constructor(address initialOwner) {
        _transferOwnership(initialOwner);
    }

    /// @notice The version of the upgrade interface of the contract. If this getter is missing, both `upgrade(address,address)`
    /// and `upgradeAndCall(address,address,bytes)` are present, and `upgrade` must be used if no function should be called,
    /// while `upgradeAndCall` will invoke the `receive` function if the third argument is the empty byte string.
    /// If the getter returns `"5.0.0"`, only `upgradeAndCall(address,address,bytes)` is present, and the third argument must
    /// be the empty byte string if no function should be called, making it impossible to invoke the `receive` function
    /// during an upgrade.
    function UPGRADE_INTERFACE_VERSION() external pure override returns (string memory) {
        return "5.0.0";
    }

    /// @notice Upgrades `proxy` to `implementation` and calls a function on the new implementation.
    /// @param proxy The proxy to upgrade.
    /// @param implementation The implementation to upgrade to.
    /// @param data The encoded function data to call on the new implementation.
    function upgradeAndCall(
        address proxy,
        address implementation,
        bytes memory data
    ) public payable override virtual onlyOwner {
        ITransparentUpgradeableProxy(proxy).upgradeToAndCall{value: msg.value}(implementation, data);
    }
}
