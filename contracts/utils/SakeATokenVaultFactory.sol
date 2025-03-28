// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/interfaces/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable2StepWTR } from "./Ownable2StepWTR.sol";
import { SakeTransparentUpgradeableProxy } from "./../proxy/SakeTransparentUpgradeableProxy.sol";
import { ISakeATokenVault } from "./../interfaces/tokens/ISakeATokenVault.sol";
import { ISakeATokenVaultFactory } from "./../interfaces/utils/ISakeATokenVaultFactory.sol";
import { Errors } from "./../libraries/Errors.sol";


/// @title SakeATokenVaultFactory
/// @author Sake Finance
/// @notice A factory for creating SakeATokenVaults.
contract SakeATokenVaultFactory is Ownable2StepWTR, ISakeATokenVaultFactory {
    
    /// @notice Constructs the SakeATokenVaultFactory.
    /// @param initialOwner The initial owner of the contract.
    constructor(address initialOwner) {
        _transferOwnership(initialOwner);
    }
    
    /// @notice Creates a new SakeATokenVault.
    /// @param implementation The implementation of the SakeATokenVault.
    /// @param proxyAdmin The admin of the proxy. Used to upgrade the proxy.
    /// @param proxyOwner The owner of the proxy. Used to manage the vault.
    /// @param createSalt The salt used to deploy the proxy.
    /// @param shareName The name of the vault token.
    /// @param shareSymbol The symbol of the vault token.
    /// @param depositAToken True if the vault should be initialized with an aToken, false if it should be initialized with an underlying.
    /// @param initialDepositAmount The amount of the initial deposit.
    function createVault(
        address implementation,
        address proxyAdmin,
        address proxyOwner,
        bytes32 createSalt,
        string memory shareName,
        string memory shareSymbol,
        bool depositAToken,
        uint256 initialDepositAmount
    ) external override returns (address proxy) {
        // checks
        if(initialDepositAmount == 0) revert Errors.AmountZero();
        // deploy
        bytes memory data = abi.encodeWithSelector(ISakeATokenVault.initialize.selector, proxyOwner, shareName, shareSymbol);
        proxy = address(new SakeTransparentUpgradeableProxy{salt: createSalt}(implementation, proxyAdmin, data));
        // initial deposit
        // if depositing the atoken
        if(depositAToken) {
            address initialDepositToken = ISakeATokenVault(proxy).aToken();
            SafeERC20.safeTransferFrom(IERC20(initialDepositToken), msg.sender, address(this), initialDepositAmount);
            SafeERC20.forceApprove(IERC20(initialDepositToken), proxy, initialDepositAmount);
            ISakeATokenVault(proxy).depositATokens(initialDepositAmount, msg.sender);
        }
        // if depositing the underlying
        else {
            address initialDepositToken = ISakeATokenVault(proxy).underlying();
            SafeERC20.safeTransferFrom(IERC20(initialDepositToken), msg.sender, address(this), initialDepositAmount);
            SafeERC20.forceApprove(IERC20(initialDepositToken), proxy, initialDepositAmount);
            ISakeATokenVault(proxy).deposit(initialDepositAmount, msg.sender);
        }
        // emit event
        emit VaultCreated(proxy);
    }

}
