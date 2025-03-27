// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;


/**
 * @title Errors
 * @author Sake Finance
 * @notice A library of custom error types used in BOOM!.
 */
library Errors {

    // call errors
    /// @notice Thrown when a low level call reverts without a reason.
    error CallFailed();
    /// @notice Thrown when a low level delegatecall reverts without a reason.
    error DelegateCallFailed();
    /// @notice Thrown when using an address with no code.
    error NotAContract();
    /// @notice Thrown when a contract deployment fails.
    error ContractNotDeployed();
    /// @notice Thrown when the sender has an insufficient balance of the token they are sending.
    error InsufficientBalance();

    // ownership & authentication errors
    /// @notice Thrown when calling a function reserved for the contract owner.
    error NotContractOwner();
    /// @notice Thrown when calling a function reserved for the pending contract owner.
    error NotPendingContractOwner();
    
    // input errors
    /// @notice Thrown when address zero is used where it should not be.
    error AddressZero();
    /// @notice Thrown when a zero amount used where it should not be.
    error AmountZero();
    /// @notice Thrown when an asset is not in the pool.
    error AssetNotInPool();
    /// @notice Thrown when an asset is invalid.
    error AssetInvalid();

    // math errors
    /// @notice Thrown when depositing for zero shares.
    error ZeroShares();
    /// @notice Thrown when redeeming for zero assets.
    error ZeroAssets();

    // transfer errors
    /// @notice Thrown when a token transfer fails.
    error TransferFailed();
    /// @notice Thrown when trying to rescue the underlying token.
    error CannotRescueUnderlying();
    /// @notice Thrown when trying to rescue the atoken.
    error CannotRescueAToken();
}
