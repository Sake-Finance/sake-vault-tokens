// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";


/// @title ISakeATokenVault
/// @author Sake Finance
/// @notice An ERC4626 wrapper that earns yield from Sake aTokens.
///
/// This implementation was optimized for use in dex pools.
///
/// Most ERC4626 waTokens always hold 100% of their assets as the aToken, 0% as the underlying, which is optimal for capital efficiency.
/// This implementation relaxes that constraint, allowing it to hold the underlying if necessary. It still aims to hold 100% of its assets as the aToken.
/// This removes some but not all of the edge cases that can cause reverts when trading.
///
/// To illustrate this example, let's look at a waUSDC/SONE dex pool.
///
/// Trades from USDC to SONE will call waUSDC `deposit` or `mint`.
/// In other implementations, these functions are capped by the aToken supply cap. Once this is reached, these trade will revert.
/// Pool supplies are also reverted if the reserve is inactive, frozen, or paused.
/// In this implementation, the maximum amount will be supplied to Sake and any leftover will be held as the underlying, allowing these trades to succeed.
///
/// Trades from SONE to USDC will call waUSDC `withdraw` or `redeem`, which then call pool `withdraw`.
/// These functions are limited by the amount that can be withdrawn from the Sake pool.
/// Once the available liquidity has been used, these trades will revert.
/// Pool withdraws are also reverted if the reserve is inactive or paused.
/// In this implementation, these functions will withdraw from any underlying balances first, then the aToken. This does not guarantee the trade will succeed, but can give it some more buffer room.
///
/// This vault has also been gas optimized for dex use.
interface ISakeATokenVault is IERC4626 {

    /***************************************
    EVENTS
    ***************************************/

    /// @notice Emitted when Aave rewards are claimed.
    /// @param to The recipient address where the claimed rewards are sent to.
    /// @param rewardsList The list of rewards address that have been claimed.
    /// @param claimedAmounts The list of rewards amount that have been claimed.
    event RewardsClaimed(address indexed to, address[] rewardsList, uint256[] claimedAmounts);

    /// @notice Emitted when tokens are rescued from this contract.
    /// @param token The address of the token that has been rescued.
    /// @param to The recipient address where the rescued tokens are sent to.
    /// @param amount The amount of tokens rescued.
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    /***************************************
    INITIALIZER
    ***************************************/

    /// @notice Initializes the vault, setting the initial parameters and initializing inherited contracts.
    /// @dev This initializes the balances at zero. The intial deposit should be done externally.
    /// @dev It does not initialize the OwnableUpgradeable contract to avoid setting the proxy admin as the owner.
    /// @param owner The initial contract owner.
    /// @param shareName The name to set for this vault.
    /// @param shareSymbol The symbol to set for this vault.
    function initialize(
        address owner,
        string memory shareName,
        string memory shareSymbol
    ) external;

    /***************************************
    DEPOSIT AND WITHDRAW FUNCTIONS
    ***************************************/

    /// @notice Deposits a specified amount of aToken assets into the vault, minting a corresponding amount of shares.
    /// @dev The assets transferred in could be lesser than the passed amount due to rounding issues.
    /// @param assets The amount of aToken assets to deposit.
    /// @param receiver The address to receive the shares.
    /// @return shares The amount of shares minted to the receiver.
    function depositATokens(uint256 assets, address receiver) external returns (uint256 shares);

    /// @notice Mints a specified amount of shares to the receiver, depositing the corresponding amount of aToken assets.
    /// @param shares The amount of shares to mint.
    /// @param receiver The address to receive the shares.
    /// @return assets The amount of aToken assets deposited by the caller.
    function mintWithATokens(uint256 shares, address receiver) external returns (uint256 assets);

    /// @notice Withdraws a specified amount of aToken assets from the vault, burning the corresponding amount of shares.
    /// @param assets The amount of aToken assets to withdraw.
    /// @param receiver The address to receive the aToken assets.
    /// @param owner The address from which to pull the shares for the withdrawal.
    /// @return shares The amount of shares burnt in the withdrawal process.
    function withdrawATokens(uint256 assets, address receiver, address owner) external returns (uint256 shares);

    /// @notice Burns a specified amount of shares from the vault, withdrawing the corresponding amount of aToken assets.
    /// @param shares The amount of shares to burn.
    /// @param receiver The address to receive the aToken assets.
    /// @param owner The address from which to pull the shares for the withdrawal.
    /// @return assets The amount of aToken assets withdrawn by the receiver.
    function redeemAsATokens(uint256 shares, address receiver, address owner) external returns (uint256 assets);

    /// @notice Rebalances this vaults positions.
    /// It will attempt to supply as much underlying to atoken and hold any underlying it cannot supply.
    function rebalance() external;

    /***************************************
    DEPOSIT AND WITHDRAW QUOTE FUNCTIONS
    ***************************************/

    /// @notice Returns the maximum amount of aToken assets that can be withdrawn from the owner balance in the vault.
    /// @dev It takes Sake Pool limitations into consideration.
    /// @param owner The address from which to pull the shares for the withdrawal.
    /// @return maxAssets The maximum amount of aToken assets that can be withdrawn.
    function maxWithdrawAsATokens(address owner) external view returns (uint256 maxAssets);

    /// @notice Returns the maximum amount of shares that can be redeemed from the owner balance in the vault when redeeming for aTokens.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @return maxShares The maximum amount of shares that can be redeemed.
    function maxRedeemAsATokens(address owner) external view returns (uint256 maxShares);

    /// @notice Allows a user to simulate a withdraw of aTokens at the current block, given current on-chain conditions.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @param assets The amount of assets the withdraw simulation uses.
    /// @return shares The amount of shares that would be burnt in the withdrawal process.
    function previewWithdrawAsATokens(uint256 assets) external view returns (uint256 shares);

    /// @notice Allows a user to simulate a redeem of aTokens at the current block, given current on-chain conditions.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @param shares The amount of shares the redeem simulation uses.
    /// @return assets The amount of assets that would be withdrawn by the receiver.
    function previewRedeemAsATokens(uint256 shares) external view returns (uint256 assets);

    /***************************************
    VIEW FUNCTIONS
    ***************************************/

    /// @notice Returns the address of the underlying token.
    /// @dev Same as asset.
    /// @return underlying_ The address of the underlying token.
    function underlying() external view returns (address underlying_);

    /// @notice Returns the address of the atoken.
    /// @return aToken_ The address of the atoken.
    function aToken() external view returns (address aToken_);

    /// @notice Returns the address of the Sake pool.
    /// @return pool_ The address of the Sake pool.
    function pool() external view returns (address pool_);

    /// @notice Returns the referral code for pool supplies.
    /// @return referralCode_ The referral code.
    function referralCode() external view returns (uint16 referralCode_);

    /***************************************
    OWNER FUNCTIONS
    ***************************************/

    /// @notice Claims any additional rewards earned from Sake deposits.
    /// Can only be called by the contract owner.
    /// @param to The address to receive any rewards tokens.
    function claimRewards(address to) external;

    /// @notice Rescues any tokens that may have been accidentally transferred to the vault.
    /// Can only be called by the contract owner.
    /// Cannot rescue the underlying or atoken.
    /// @param token The address of the token to rescue.
    /// @param to The address to transfer the token to.
    /// @param amount The amount of the token to transfer.
    function rescueTokens(address token, address to, uint256 amount) external;
}
