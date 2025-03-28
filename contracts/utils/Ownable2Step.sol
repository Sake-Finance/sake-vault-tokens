// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IOwnable2Step } from "./../interfaces/utils/IOwnable2Step.sol";
import { Errors } from "./../libraries/Errors.sol";


/**
 * @title Ownable2Step
 * @author Sake Finance
 * @notice An abstract contract that provides a basic access control system through ERC173.
 *
 * Based on OpenZeppelins's implementation.
 */
abstract contract Ownable2Step is IOwnable2Step {

    /***************************************
    VARIABLES
    ***************************************/

    address private _owner;
    address private _pendingOwner;

    /**
     * @notice Throws if called by any account other than the owner.
     */
    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /***************************************
    VIEW FUNCTIONS
    ***************************************/

    /**
     * @notice Returns the address of the current owner.
     * @return owner_ The current owner.
     */
    function owner() public view override returns (address owner_) {
        owner_ = _owner;
    }

    /**
     * @notice Returns the address of the pending owner.
     * @return pendingOwner_ The pending owner.
     */
    function pendingOwner() public view override returns (address pendingOwner_) {
        pendingOwner_ = _pendingOwner;
    }

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
    function renounceOwnership() public payable override onlyOwner {
        _transferOwnership(address(0));
    }

    /**
     * @notice Starts the ownership transfer of the contract to a new account. Replaces the pending transfer if there is one.
     * Can only be called by the current owner.
     * @param newOwner The address of the new owner.
     */
    function transferOwnership(address newOwner) public payable override onlyOwner {
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    /**
     * @notice Completes the ownership transfer of the contract to the new account.
     * Can only be called by the pending owner.
     */
    function acceptOwnership() public payable override {
        address sender = msg.sender;
        if(_pendingOwner != sender) revert Errors.NotPendingContractOwner();
        _transferOwnership(sender);
    }

    /***************************************
    HELPER FUNCTIONS
    ***************************************/

    /**
     * @notice Throws if the sender is not the owner.
     */
    function _checkOwner() internal view {
        if(_owner != msg.sender) revert Errors.NotContractOwner();
    }

    /**
     * @notice Transfers ownership of the contract to a new account (`newOwner`) and deletes any pending owner.
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal {
        _pendingOwner = address(0);
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}
