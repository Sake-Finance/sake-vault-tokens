// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Calls } from "./../../libraries/Calls.sol";


/**
 * @title SometimesRevertAccount
 * @notice An account that reverts if it feels like it.
 *
 * Only used to test other contracts.
*/
contract SometimesRevertAccount {

    error UnknownError();

    uint256 public revertMode;

    receive () external payable {
        _handle();
    }

    fallback () external payable {
        _handle();
    }

    function selfSend() external payable {
        uint256 balance = address(this).balance;
        Calls.sendValue(address(this), balance);
    }

    function selfFunctionCall(bytes memory data) external payable {
        Calls.functionCall(address(this), data);
    }

    function setRevertMode(uint256 mode) external payable {
        revertMode = mode;
    }

    function _handle() internal {
        uint256 mode = revertMode;
        if(mode == 0) return;
        else if(mode == 1) revert();
        else if(mode == 2) revert UnknownError();
        else revert("generic error");
    }
}
