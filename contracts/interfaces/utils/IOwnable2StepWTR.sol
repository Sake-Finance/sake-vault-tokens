// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IOwnable2Step } from "./IOwnable2Step.sol";


/**
 * @title IOwnable2StepWTR
 * @author Sake Finance
 * @notice An extention of IOwnable2Step that allows the contract owner to rescue tokens that may have been transferred into this contract.
 */
interface IOwnable2StepWTR is IOwnable2Step {

    /***************************************
    RESCUE TOKEN FUNCTION
    ***************************************/

    struct RescueTokenParam {
        address token;
        uint256 amount; // For ETH and ERC20s, the amount to transfer. For ERC721s, the tokenId
        address receiver;
    }

    /**
     * @notice Rescues tokens that may have been transferred into this contract.
     * Supports the gas token, ERC20s, and ERC721s.
     * Can only be called by the contract owner.
     * @param params The tokens to rescue.
     */
    function rescueTokens(RescueTokenParam[] calldata params) external;

}
