// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import {ITransparentUpgradeableProxy} from "./../interfaces/proxy/ITransparentUpgradeableProxy.sol";

import { ERC1967Utils } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import { IERC1967 } from "@openzeppelin/contracts/interfaces/IERC1967.sol";
import { SakeProxyAdmin } from "./SakeProxyAdmin.sol";


/// @title SakeTransparentUpgradeableProxy
/// @author Sake Finance
/// @notice A transparent upgradeable proxy.
///
/// Based on OpenZeppelins's implementation, modified to use a ProxyAdmin that is passed into the constructor instead of deployed in the constructor.
/// This reduces gas fees to create multiple proxies and reduces the management overhead of multiple ProxyAdmins.
contract SakeTransparentUpgradeableProxy is ERC1967Proxy {
    // An immutable address for the admin to avoid unnecessary SLOADs before each call
    // at the expense of removing the ability to change the admin once it's set.
    // This is acceptable if the admin is always a ProxyAdmin instance or similar contract
    // with its own ability to transfer the permissions to another account.
    address private immutable _admin;

    /// @notice The proxy caller is the current admin, and can't fallback to the proxy target.
    error ProxyDeniedAdminAccess();

    /// @notice Contstructs the transparent upgradeable proxy.
    /// @param _logic The address of the implementation contract.
    /// @param admin The address of the ProxyAdmin contract.
    /// @param _data Initialization data to call on the new proxy contract.
    constructor(address _logic, address admin, bytes memory _data) payable ERC1967Proxy(_logic, _data) {
        _admin = admin;
        // Set the storage value and emit an event for ERC-1967 compatibility
        ERC1967Utils.changeAdmin(admin);
    }

    /// @dev Returns the admin of this proxy.
    function _proxyAdmin() internal view virtual returns (address) {
        return _admin;
    }

    /// @dev If caller is the admin process the call internally, otherwise transparently fallback to the proxy behavior.
    function _fallback() internal virtual override {
        if (msg.sender == _proxyAdmin()) {
            if (msg.sig != ITransparentUpgradeableProxy.upgradeToAndCall.selector) {
                revert ProxyDeniedAdminAccess();
            } else {
                _dispatchUpgradeToAndCall();
            }
        } else {
            super._fallback();
        }
    }

    /// @notice Upgrade the implementation of the proxy.
    function _dispatchUpgradeToAndCall() private {
        (address newImplementation, bytes memory data) = abi.decode(msg.data[4:], (address, bytes));
        ERC1967Utils.upgradeToAndCall(newImplementation, data);
    }
}
