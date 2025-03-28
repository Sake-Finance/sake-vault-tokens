// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;


/// @title ISakeProxyAdmin
/// @author Sake Finance
/// @notice An auxiliary contract meant to be assigned as the admin of a TransparentUpgradeableProxy.
///
/// Based on OpenZeppelins's implementation, modified to use Ownable2StepWTR.
interface ISakeProxyAdmin {
    
    /// @notice The version of the upgrade interface of the contract. If this getter is missing, both `upgrade(address,address)`
    /// and `upgradeAndCall(address,address,bytes)` are present, and `upgrade` must be used if no function should be called,
    /// while `upgradeAndCall` will invoke the `receive` function if the third argument is the empty byte string.
    /// If the getter returns `"5.0.0"`, only `upgradeAndCall(address,address,bytes)` is present, and the third argument must
    /// be the empty byte string if no function should be called, making it impossible to invoke the `receive` function
    /// during an upgrade.
    function UPGRADE_INTERFACE_VERSION() external view returns (string memory);

    /// @notice Upgrades `proxy` to `implementation` and calls a function on the new implementation.
    /// @param proxy The proxy to upgrade.
    /// @param implementation The implementation to upgrade to.
    /// @param data The encoded function data to call on the new implementation.
    function upgradeAndCall(
        address proxy,
        address implementation,
        bytes memory data
    ) external payable;
}
