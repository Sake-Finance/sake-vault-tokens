// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable2Step } from "./Ownable2Step.sol";
import { IOwnable2StepWTR } from "./../interfaces/utils/IOwnable2StepWTR.sol";
import { Calls } from "./../libraries/Calls.sol";
import { Errors } from "./../libraries/Errors.sol";


/**
 * @title Ownable2StepWTR
 * @author Sake Finance
 * @notice An extention of Ownable2Step that allows the contract owner to rescue tokens that may have been transferred into this contract.
 */
abstract contract Ownable2StepWTR is Ownable2Step, IOwnable2StepWTR {

    /***************************************
    RESCUE TOKEN FUNCTION
    ***************************************/

    /**
     * @notice Rescues tokens that may have been transferred into this contract.
     * Supports the gas token, ERC20s, and ERC721s.
     * Can only be called by the contract owner.
     * @param params The tokens to rescue.
     */
    function rescueTokens(RescueTokenParam[] calldata params) external override onlyOwner {
        for(uint256 i = 0; i < params.length; ++i) {
            address token = params[i].token;
            // if transferring the gas token
            if(token == address(0)) {
                Calls.sendValue(payable(params[i].receiver), params[i].amount);
            }
            // if transferring an erc20 or erc721
            else {
                _transferToken(token, params[i].amount, params[i].receiver);
            }
        }
    }

    /***************************************
    HELPER FUNCTIONS
    ***************************************/

    /**
     * @notice Transfers a token. Supports both ERC20 and ERC721.
     * @param token The address of the token contract.
     * @param amount For ERC20s, the amount to transfer. For ERC721s, the tokenId.
     * @param receiver The receiver of tokens.
     */
    function _transferToken(address token, uint256 amount, address receiver) internal {
        // try transfer()
        bool success = _callOptionalReturnBool(token, abi.encodeCall(IERC20.transfer, (receiver, amount)));
        // if transfer() was not successful
        if(!success) {
            // try transferFrom()
            success = _callOptionalReturnBool(token, abi.encodeCall(IERC20.transferFrom, (address(this), receiver, amount)));
            // if transferFrom() was not successful
            if(!success) revert Errors.TransferFailed();
        }
    }

    /**
     * @notice Imitates a Solidity high-level call (i.e. a regular function call to a contract), relaxing the requirement
     * on the return value: the return value is optional (but if data is returned, it must not be false).
     * This is a variant of _callOptionalReturn that silently catches all reverts and returns a bool instead.
     * @param token The token targeted by the call.
     * @param data The call data (encoded using abi.encode or one of its variants).
     */
    function _callOptionalReturnBool(address token, bytes memory data) private returns (bool) {
        bool success;
        uint256 returnSize;
        uint256 returnValue;
        assembly ("memory-safe") {
            success := call(gas(), token, 0, add(data, 0x20), mload(data), 0, 0x20)
            returnSize := returndatasize()
            returnValue := mload(0)
        }
        return success && (returnSize == 0 ? token.code.length > 0 : returnValue == 1);
    }
}
