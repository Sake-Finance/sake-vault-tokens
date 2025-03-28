// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;


/// @title ISakeATokenVaultFactory
/// @author Sake Finance
/// @notice A factory for creating SakeATokenVaults.
interface ISakeATokenVaultFactory {
    
    /// @notice Emitted when a new vault is created.
    event VaultCreated(address indexed proxy);
    
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
    ) external returns (address proxy);

}
