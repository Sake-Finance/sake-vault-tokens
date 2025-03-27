// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import { IERC1967 } from "@openzeppelin/contracts/interfaces/IERC1967.sol";


/// @title ITransparentUpgradeableProxy
/// @notice Interface for TransparentUpgradeableProxy.
///
/// In order to implement transparency, TransparentUpgradeableProxy does not implement this interface directly, and its upgradeability mechanism is implemented by an internal dispatch mechanism. The compiler is unaware that these functions are implemented by TransparentUpgradeableProxy and will not include them in the ABI so this interface must be used to interact with it.
interface ITransparentUpgradeableProxy is IERC1967 {
    /// @notice Upgrade the implementation of the proxy.
    /// Can only be called by the ProxyAdmin.
    /// @param newImplementation The address of the new implementation contract.
    /// @param data Data to call on the new proxy contract.
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}
