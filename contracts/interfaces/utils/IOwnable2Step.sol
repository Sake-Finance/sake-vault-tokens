// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;


/**
 * @title IOwnable2Step
 * @author Sake Finance
 * @notice An abstract contract that provides a basic access control system through ERC173.
 */
interface IOwnable2Step {

    /***************************************
    EVENTS
    ***************************************/

    /// @notice Emitted when the contract ownership process is started.
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    /// @notice Emitted when the contract ownership process is completed.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /***************************************
    VIEW FUNCTIONS
    ***************************************/

    /**
     * @notice Returns the address of the current owner.
     * @return owner_ The current owner.
     */
    function owner() external view returns (address owner_);

    /**
     * @notice Returns the address of the pending owner.
     * @return pendingOwner_ The pending owner.
     */
    function pendingOwner() external view returns (address pendingOwner_);

    /***************************************
    MUTATOR FUNCTIONS
    ***************************************/

    /**
     * @notice Leaves the contract without owner. It will not be possible to call
     * `onlyOwner` functions. Can only be called by the current owner.
     *
     * NOTE: Renouncing ownership will leave the contract without an owner,
     * thereby disabling any functionality that is only available to the owner.
     */
    function renounceOwnership() external payable;

    /**
     * @notice Starts the ownership transfer of the contract to a new account. Replaces the pending transfer if there is one.
     * Can only be called by the current owner.
     * @param newOwner The address of the new owner.
     */
    function transferOwnership(address newOwner) external payable;

    /**
     * @notice Completes the ownership transfer of the contract to the new account.
     * Can only be called by the pending owner.
     */
    function acceptOwnership() external payable;
}
