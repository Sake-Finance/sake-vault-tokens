// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/interfaces/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { ERC4626Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPool } from "@aave/core-v3/contracts/interfaces/IPool.sol";
import { IAToken } from "@aave/core-v3/contracts/interfaces/IAToken.sol";
import { DataTypes as AaveDataTypes } from "@aave/core-v3/contracts/protocol/libraries/types/DataTypes.sol";
import { WadRayMath } from "@aave/core-v3/contracts/protocol/libraries/math/WadRayMath.sol";
import { ReserveConfiguration } from "@aave/core-v3/contracts/protocol/libraries/configuration/ReserveConfiguration.sol";
import { IncentivizedERC20 } from "@aave/core-v3/contracts/protocol/tokenization/base/IncentivizedERC20.sol";
import { IRewardsController } from "@aave/periphery-v3/contracts/rewards/interfaces/IRewardsController.sol";

import { ISakeATokenVault } from "./../interfaces/tokens/ISakeATokenVault.sol";
import { Errors } from "./../libraries/Errors.sol";


/// @title SakeATokenVault
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
contract SakeATokenVault is ERC4626Upgradeable, Ownable2StepUpgradeable, ISakeATokenVault {

    /***************************************
    CONSTANTS
    ***************************************/
    
    address internal immutable _sakePool;
    address internal immutable _atoken;
    address internal immutable _underlying;
    uint16 internal immutable _referralCode;

    /***************************************
    CONSTRUCTOR
    ***************************************/
    
    /// @notice Constructs the SakeATokenVault contract.
    /// @param underlying_ The underlying ERC20 asset which can be supplied to Sake.
    /// @param atoken_ The atoken that is received when supplying to Sake.
    /// @param sakePool_ The Sake Pool to supply to..
    /// @param referralCode_ The Sake referral code to use for deposits from this vault.
    constructor(
        address underlying_,
        address atoken_,
        address sakePool_,
        uint16 referralCode_
    ) {
        // checks
        if(underlying_ == address(0) || atoken_ == address(0) || sakePool_ == address(0)) revert Errors.AddressZero();
        address aTokenAddress = IPool(sakePool_).getReserveData(underlying_).aTokenAddress;
        if(aTokenAddress == address(0)) revert Errors.AssetNotInPool();
        if(aTokenAddress != atoken_) revert Errors.AssetInvalid();
        // disable initialization on the implementation contract
        _disableInitializers();
        // store immutable variables
        _underlying = underlying_;
        _atoken = atoken_;
        _sakePool = sakePool_;
        _referralCode = referralCode_;
    }

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
    ) external override initializer {
        if(owner == address(0)) revert Errors.AddressZero();
        __ERC4626_init(IERC20(_underlying));
        __ERC20_init(shareName, shareSymbol);
        __Ownable2Step_init_unchained();
        _transferOwnership(owner);
        
        SafeERC20.forceApprove(IERC20(_underlying), _sakePool, type(uint256).max);
    }

    /***************************************
    DEPOSIT AND WITHDRAW FUNCTIONS
    ***************************************/

    /// @notice Deposits a specified amount of assets into the vault, minting a corresponding amount of shares.
    /// @dev The assets transferred in could be lesser than the passed amount due to rounding issues.
    /// @param assets The amount of underlying asset to deposit.
    /// @param receiver The address to receive the shares.
    /// @return shares The amount of shares minted to the receiver.
    function deposit(uint256 assets, address receiver) public override(ERC4626Upgradeable, IERC4626) returns (uint256 shares) {
        shares = _handleDeposit(assets, receiver, msg.sender, false);
    }

    /// @notice Deposits a specified amount of aToken assets into the vault, minting a corresponding amount of shares.
    /// @dev The assets transferred in could be lesser than the passed amount due to rounding issues.
    /// @param assets The amount of aToken assets to deposit.
    /// @param receiver The address to receive the shares.
    /// @return shares The amount of shares minted to the receiver.
    function depositATokens(uint256 assets, address receiver) external override returns (uint256 shares) {
        shares = _handleDeposit(assets, receiver, msg.sender, true);
    }

    /// @notice Mints a specified amount of shares to the receiver, depositing the corresponding amount of assets.
    /// @param shares The amount of shares to mint.
    /// @param receiver The address to receive the shares.
    /// @return assets The amount of assets deposited by the caller.
    function mint(uint256 shares, address receiver) public override(ERC4626Upgradeable, IERC4626) returns (uint256 assets) {
        assets = _handleMint(shares, receiver, msg.sender, false);
    }

    /// @notice Mints a specified amount of shares to the receiver, depositing the corresponding amount of aToken assets.
    /// @param shares The amount of shares to mint.
    /// @param receiver The address to receive the shares.
    /// @return assets The amount of aToken assets deposited by the caller.
    function mintWithATokens(uint256 shares, address receiver) external override returns (uint256 assets) {
        assets = _handleMint(shares, receiver, msg.sender, true);
    }

    /// @notice Withdraws a specified amount of assets from the vault, burning the corresponding amount of shares.
    /// @param assets The amount of assets to withdraw.
    /// @param receiver The address to receive the assets.
    /// @param owner The address from which to pull the shares for the withdrawal.
    /// @return shares The amount of shares burnt in the withdrawal process.
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override(ERC4626Upgradeable, IERC4626) returns (uint256 shares) {
        shares = _handleWithdraw(assets, receiver, owner, msg.sender, false);
    }

    /// @notice Withdraws a specified amount of aToken assets from the vault, burning the corresponding amount of shares.
    /// @param assets The amount of aToken assets to withdraw.
    /// @param receiver The address to receive the aToken assets.
    /// @param owner The address from which to pull the shares for the withdrawal.
    /// @return shares The amount of shares burnt in the withdrawal process.
    function withdrawATokens(uint256 assets, address receiver, address owner) external override returns (uint256 shares) {
        shares = _handleWithdraw(assets, receiver, owner, msg.sender, true);
    }

    /// @notice Burns a specified amount of shares from the vault, withdrawing the corresponding amount of assets.
    /// @param shares The amount of shares to burn.
    /// @param receiver The address to receive the assets.
    /// @param owner The address from which to pull the shares for the withdrawal.
    /// @return assets The amount of assets withdrawn by the receiver.
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public override(ERC4626Upgradeable, IERC4626) returns (uint256 assets) {
        assets = _handleRedeem(shares, receiver, owner, msg.sender, false);
    }

    /// @notice Burns a specified amount of shares from the vault, withdrawing the corresponding amount of aToken assets.
    /// @param shares The amount of shares to burn.
    /// @param receiver The address to receive the aToken assets.
    /// @param owner The address from which to pull the shares for the withdrawal.
    /// @return assets The amount of aToken assets withdrawn by the receiver.
    function redeemAsATokens(uint256 shares, address receiver, address owner) external override returns (uint256 assets) {
        assets = _handleRedeem(shares, receiver, owner, msg.sender, true);
    }

    /// @notice Rebalances this vaults positions.
    /// It will attempt to supply as much underlying to atoken and hold any underlying it cannot supply.
    function rebalance() external {
        _rebalance();
    }

    /***************************************
    DEPOSIT AND WITHDRAW QUOTE FUNCTIONS
    ***************************************/

    /// @notice Returns the maximum amount of assets that can be deposited into the vault.
    /// @dev It does not take Sake Pool limitations into consideration. Any underlying that cannot be supplied will be held as underlying.
    /// @return maxAssets The maximum amount of assets that can be deposited into the vault.
    function maxDeposit(address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256 maxAssets) {
        // no minimum, any underlying that cannot be supplied will be held as underlying
        maxAssets = type(uint256).max;
    }

    /// @notice Returns the maximum amount of shares that can be minted for the vault.
    /// @dev It does not take Sake Pool limitations into consideration. Any underlying that cannot be supplied will be held as underlying.
    /// @return maxShares The maximum amount of shares that can be minted for the vault.
    function maxMint(address) public pure override(ERC4626Upgradeable, IERC4626) returns (uint256 maxShares) {
        // no minimum, any underlying that cannot be supplied will be held as underlying
        maxShares = type(uint256).max;
    }

    /// @notice Returns the maximum amount of underlying assets that can be withdrawn from the owner balance in the vault.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @param owner The address from which to pull the shares for the withdrawal.
    /// @return maxAssets The maximum amount of underlying assets that can be withdrawn.
    function maxWithdraw(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256 maxAssets) {
        // check user balance
        uint256 userBalance = balanceOf(owner);
        if (userBalance == 0) return 0;
        // get vault holdings
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert user balance to assets
        uint256 userAssetsValue = Math.mulDiv(userBalance, ta, ts, Math.Rounding.Floor);
        // if there is sufficient underlying balance
        if (underlyingBalance >= userAssetsValue) {
            // user can withdraw up to their underlying value
            return userAssetsValue;
        }
        // get max withdrawable from sake, factoring in atoken balance, and add to underlying balance
        underlyingBalance += Math.min(_maxAssetsWithdrawableFromSake(), atokenBalance);
        // if there is sufficient underlying + withdrawable
        if (underlyingBalance >= userAssetsValue) {
            // user can withdraw up to their underlying value
            return userAssetsValue;
        }
        // otherwise user can withdraw up to underlying + withdrawable
        return underlyingBalance;
    }

    /// @notice Returns the maximum amount of aToken assets that can be withdrawn from the owner balance in the vault.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @param owner The address from which to pull the shares for the withdrawal.
    /// @return maxAssets The maximum amount of aToken assets that can be withdrawn.
    function maxWithdrawAsATokens(address owner) external view override returns (uint256 maxAssets) {
        // check user balance
        uint256 userBalance = balanceOf(owner);
        if (userBalance == 0) return 0;
        // get vault holdings
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert user balance to assets
        uint256 userAssetsValue = Math.mulDiv(userBalance, ta, ts, Math.Rounding.Floor);
        // if there is sufficient atoken balance
        if (atokenBalance >= userAssetsValue) {
            // user can withdraw up to their underlying value
            return userAssetsValue;
        }
        // get max suppliable to sake, factoring in underlying balance, and add to atoken balance
        atokenBalance += Math.min(_maxAssetsSuppliableToSake(), underlyingBalance);
        // if there is sufficient atoken + suppliable
        if (atokenBalance >= userAssetsValue) {
            // user can withdraw up to their underlying value
            return userAssetsValue;
        }
        // otherwise user can withdraw up to atoken + suppliable
        return atokenBalance;
    }

    /// @notice Returns the maximum amount of shares that can be redeemed from the owner balance in the vault when redeeming for underlying.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @return maxShares The maximum amount of shares that can be redeemed.
    function maxRedeem(address owner) public view override(ERC4626Upgradeable, IERC4626) returns (uint256 maxShares) {
        // check user balance
        uint256 userBalance = balanceOf(owner);
        if (userBalance == 0) return 0;
        // get vault holdings
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert user balance to assets
        uint256 userAssetsValue = Math.mulDiv(userBalance, ta, ts, Math.Rounding.Floor);
        // if there is sufficient underlying balance
        if (underlyingBalance >= userAssetsValue) {
            // user can redeem up to their balance
            return userBalance;
        }
        // get max withdrawable from sake, factoring in atoken balance, and add to underlying balance
        underlyingBalance += Math.min(_maxAssetsWithdrawableFromSake(), atokenBalance);
        // if there is sufficient underlying + withdrawable
        if (underlyingBalance >= userAssetsValue) {
            // user can redeem up to their balance
            return userBalance;
        }
        // otherwise user can withdraw up to underlying + withdrawable worth of shares
        return Math.mulDiv(underlyingBalance, ts, ta, Math.Rounding.Floor);
    }

    /// @notice Returns the maximum amount of shares that can be redeemed from the owner balance in the vault when redeeming for aTokens.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @return maxShares The maximum amount of shares that can be redeemed.
    function maxRedeemAsATokens(address owner) external view override returns (uint256 maxShares) {
        // check user balance
        uint256 userBalance = balanceOf(owner);
        if (userBalance == 0) return 0;
        // get vault holdings
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert user balance to assets
        uint256 userAssetsValue = Math.mulDiv(userBalance, ta, ts, Math.Rounding.Floor);
        // if there is sufficient atoken balance
        if (atokenBalance >= userAssetsValue) {
            // user can redeem up to their balance
            return userBalance;
        }
        // get max suppliable to sake, factoring in underlying balance, and add to atoken balance
        atokenBalance += Math.min(_maxAssetsSuppliableToSake(), underlyingBalance);
        // if there is sufficient atoken + suppliable
        if (atokenBalance >= userAssetsValue) {
            // user can redeem up to their balance
            return userBalance;
        }
        // otherwise user can withdraw up to atoken + suppliable worth of shares
        return Math.mulDiv(atokenBalance, ts, ta, Math.Rounding.Floor);
    }

    /// @notice Allows a user to simulate a deposit at the current block, given current on-chain conditions.
    /// @dev It does not take Sake Pool limitations into consideration. Any underlying that cannot be supplied will be held as underlying.
    /// @param assets The amount of assets the deposit simulation uses.
    /// @return shares The amount of shares that would be minted to the receiver.
    function previewDeposit(uint256 assets) public view override(ERC4626Upgradeable, IERC4626) returns (uint256 shares) {
        if(assets == 0) return 0;
        // get vault info
        ( , , uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert to shares
        shares = Math.mulDiv(assets, ts, ta, Math.Rounding.Floor);
    }

    /// @notice Allows a user to simulate a mint at the current block, given current on-chain conditions.
    /// @dev It does not take Sake Pool limitations into consideration. Any underlying that cannot be supplied will be held as underlying.
    /// @param shares The amount of shares the mint simulation uses.
    /// @return assets The amount of assets that would be deposited by the caller.
    function previewMint(uint256 shares) public view override(ERC4626Upgradeable, IERC4626) returns (uint256 assets) {
        if(shares == 0) return 0;
        // get vault info
        ( , , uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert to assets
        assets = Math.mulDiv(shares, ta, ts, Math.Rounding.Ceil);
    }

    /// @notice Allows a user to simulate a withdraw of underlying at the current block, given current on-chain conditions.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @param assets The amount of assets the withdraw simulation uses.
    /// @return shares The amount of shares that would be burnt in the withdrawal process.
    function previewWithdraw(uint256 assets) public view override(ERC4626Upgradeable, IERC4626) returns (uint256 shares) {
        if(assets == 0) return 0;
        // get vault info
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // limit assets by balances and max withdrawable from sake
        assets = Math.min(underlyingBalance + Math.min(atokenBalance, _maxAssetsWithdrawableFromSake()), assets);
        // convert to shares
        shares = Math.mulDiv(assets, ts, ta, Math.Rounding.Ceil);
    }

    /// @notice Allows a user to simulate a withdraw of aTokens at the current block, given current on-chain conditions.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @param assets The amount of assets the withdraw simulation uses.
    /// @return shares The amount of shares that would be burnt in the withdrawal process.
    function previewWithdrawAsATokens(uint256 assets) external view override returns (uint256 shares) {
        if(assets == 0) return 0;
        // get vault info
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // limit assets by balances and max suppliable to sake
        assets = Math.min(atokenBalance + Math.min(underlyingBalance, _maxAssetsSuppliableToSake()), assets);
        // convert to shares
        shares = Math.mulDiv(assets, ts, ta, Math.Rounding.Ceil);
    }

    /// @notice Allows a user to simulate a redeem of underlying at the current block, given current on-chain conditions.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @param shares The amount of shares the redeem simulation uses.
    /// @return assets The amount of assets that would be withdrawn by the receiver.
    function previewRedeem(uint256 shares) public view override(ERC4626Upgradeable, IERC4626) returns (uint256 assets) {
        if(shares == 0) return 0;
        // get vault info
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert to assets
        assets = Math.mulDiv(shares, ta, ts, Math.Rounding.Ceil);
        // limit assets by balances and max withdrawable from sake
        assets = Math.min(underlyingBalance + Math.min(atokenBalance, _maxAssetsWithdrawableFromSake()), assets);
    }

    /// @notice Allows a user to simulate a redeem of aTokens at the current block, given current on-chain conditions.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @param shares The amount of shares the redeem simulation uses.
    /// @return assets The amount of assets that would be withdrawn by the receiver.
    function previewRedeemAsATokens(uint256 shares) external view override returns (uint256 assets) {
        if(shares == 0) return 0;
        // get vault info
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert to assets
        assets = Math.mulDiv(shares, ta, ts, Math.Rounding.Ceil);
        // limit assets by balances and max suppliable to sake
        assets = Math.min(atokenBalance + Math.min(underlyingBalance, _maxAssetsSuppliableToSake()), assets);
    }

    /***************************************
    VIEW FUNCTIONS
    ***************************************/

    /// @notice Returns the total assets managed by the vault.
    /// @return totalManagedAssets The total assets.
    function totalAssets() public view override(ERC4626Upgradeable, IERC4626) returns (uint256 totalManagedAssets) {
        totalManagedAssets = IERC20(_underlying).balanceOf(address(this)) + IERC20(_atoken).balanceOf(address(this));
    }

    /// @notice Returns the address of the underlying token.
    /// @dev Same as asset.
    /// @return underlying_ The address of the underlying token.
    function underlying() external view override returns (address underlying_) {
        underlying_ = _underlying;
    }

    /// @notice Returns the address of the atoken.
    /// @return aToken_ The address of the atoken.
    function aToken() external view override returns (address aToken_) {
        aToken_ = _atoken;
    }

    /// @notice Returns the address of the Sake pool.
    /// @return pool_ The address of the Sake pool.
    function pool() external view override returns (address pool_) {
        pool_ = _sakePool;
    }

    /// @notice Returns the referral code for pool supplies.
    /// @return referralCode_ The referral code.
    function referralCode() external view override returns (uint16 referralCode_) {
        referralCode_ = _referralCode;
    }

    /// @notice Gets the maximum amount of assets that can be supplied to Sake.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @dev It does not factor in the balances of this contract.
    /// @return assets The maximum amount of assets that can be supplied to Sake.
    function maxAssetsSuppliableToSake() external view returns (uint256 assets) {
        assets = _maxAssetsSuppliableToSake();
    }
    
    /// @notice Gets the maximum amount of assets that can be withdrawn from Sake.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @dev It does not factor in the balances of this contract.
    /// @return assets The maximum amount of assets that can be withdrawn from Sake.
    function maxAssetsWithdrawableFromSake() external view returns (uint256 assets) {
        assets = _maxAssetsWithdrawableFromSake();
    }

    /***************************************
    OWNER FUNCTIONS
    ***************************************/

    /// @notice Claims any additional rewards earned from Sake deposits.
    /// Can only be called by the contract owner.
    /// @param to The address to receive any rewards tokens.
    function claimRewards(address to) external override onlyOwner {
        if(to == address(0)) revert Errors.AddressZero();

        address[] memory assets = new address[](1);
        assets[0] = _atoken;
        (address[] memory rewardsList, uint256[] memory claimedAmounts) = IRewardsController(
            address(IncentivizedERC20(_atoken).getIncentivesController())
        ).claimAllRewards(assets, to);

        emit RewardsClaimed(to, rewardsList, claimedAmounts);
    }

    /// @notice Rescues any tokens that may have been accidentally transferred to the vault.
    /// Can only be called by the contract owner.
    /// Cannot rescue the underlying or atoken.
    /// @param token The address of the token to rescue.
    /// @param to The address to transfer the token to.
    /// @param amount The amount of the token to transfer.
    function rescueTokens(address token, address to, uint256 amount) external override onlyOwner {
        if(token == _underlying) revert Errors.CannotRescueUnderlying();
        if(token == _atoken) revert Errors.CannotRescueAToken();
        SafeERC20.safeTransfer(IERC20(token), to, amount);
        emit TokensRescued(token, to, amount);
    }

    /***************************************
    INTERNAL MODIFIER FUNCTIONS
    ***************************************/
    
    /// @notice Handles any deposits.
    /// @param assets The amount of assets to deposit.
    /// @param receiver The address to receive the shares.
    /// @param depositor The address to transfer assets from.
    /// @param asAToken True if the assets are aToken, false if they are underlying.
    /// @return shares The amount of shares minted to the receiver.
    function _handleDeposit(uint256 assets, address receiver, address depositor, bool asAToken) internal returns (uint256 shares) {
        // get vault holdings
        ( , , uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert to shares
        shares = Math.mulDiv(assets, ts, ta, Math.Rounding.Floor);
        if(shares == 0) revert Errors.ZeroShares(); // Check for rounding error since we round down in conversion
        // convert back to assets. always <= original assets amount
        uint256 assets2 = Math.mulDiv(shares, ta, ts, Math.Rounding.Ceil);
        // deposit
        _baseDeposit(assets2, shares, depositor, receiver, asAToken);    
    }

    /// @notice Handles any mints.
    /// @param shares The amount of shares to mint.
    /// @param receiver The address to receive the shares.
    /// @param depositor The address to transfer assets from.
    /// @param asAToken True if the assets are aToken, false if they are underlying.
    /// @return assets The amount of assets transferred from the depositor.
    function _handleMint(uint256 shares, address receiver, address depositor, bool asAToken) internal returns (uint256 assets) {
        // get vault holdings
        ( , , uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert to assets
        assets = Math.mulDiv(shares, ta, ts, Math.Rounding.Ceil);
        // deposit
        _baseDeposit(assets, shares, depositor, receiver, asAToken);
    }

    /// @notice Handles any withdraws.
    /// @param assets The amount of assets to withdraw.
    /// @param receiver The address to receive the assets.
    /// @param owner The address to burn shares from.
    /// @param allowanceTarget The address that is using allowance.
    /// @param asAToken True if the assets are aToken, false if they are underlying.
    /// @return shares The amount of shares burned from the shares owner.
    function _handleWithdraw(
        uint256 assets,
        address receiver,
        address owner,
        address allowanceTarget,
        bool asAToken
    ) internal returns (uint256 shares) {
        // get vault holdings
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert to shares
        shares = Math.mulDiv(assets, ts, ta, Math.Rounding.Ceil);
        // withdraw
        _baseWithdraw(assets, shares, owner, receiver, allowanceTarget, asAToken, underlyingBalance, atokenBalance);
        
    }

    /// @notice Handles any redeems.
    /// @param shares The amount of shares to redeem.
    /// @param receiver The address to receive the assets.
    /// @param owner The address to burn shares from.
    /// @param allowanceTarget The address that is using allowance.
    /// @param asAToken True if the assets are aToken, false if they are underlying.
    /// @return assets The amount of assets transferred to the receiver.
    function _handleRedeem(
        uint256 shares,
        address receiver,
        address owner,
        address allowanceTarget,
        bool asAToken
    ) internal returns (uint256 assets) {
        // get vault holdings
        (uint256 underlyingBalance, uint256 atokenBalance, uint256 ta, uint256 ts) = _getVaultHoldings();
        // convert to assets
        assets = Math.mulDiv(shares, ta, ts, Math.Rounding.Floor);
        if(assets == 0) revert Errors.ZeroAssets(); // Check for rounding error since we round down in conversion
        // withdraw
        _baseWithdraw(assets, shares, owner, receiver, allowanceTarget, asAToken, underlyingBalance, atokenBalance);
    }

    /// @notice The base function for any deposits or mints.
    /// @param assets The amount of assets to deposit.
    /// @param shares The amount of shares to mint.
    /// @param depositor The address to transfer assets from.
    /// @param receiver The address to receive the shares.
    /// @param asAToken True if the assets are aToken, false if they are underlying.
    function _baseDeposit(uint256 assets, uint256 shares, address depositor, address receiver, bool asAToken) private {
        // Need to transfer before minting or ERC777s could reenter.
        if (asAToken) {
            SafeERC20.safeTransferFrom(IERC20(_atoken), depositor, address(this), assets);
        } else {
            SafeERC20.safeTransferFrom(IERC20(_underlying), depositor, address(this), assets);
        }
        // mint shares
        _mint(receiver, shares);
        // rebalance if necessary
        _rebalance();
        // emit event
        emit Deposit(depositor, receiver, assets, shares);
    }
    
    /// @notice The base function for any withdraws or redeems.
    /// @param assets The amount of assets to withdraw.
    /// @param shares The amount of shares to burn.
    /// @param owner The address to burn shares from.
    /// @param receiver The address to receive the assets.
    /// @param allowanceTarget The address that is using allowance.
    /// @param asAToken True if the assets are aToken, false if they are underlying.
    /// @param underlyingBalance The amount of underlying in the vault.
    /// @param atokenBalance The amount of atoken in the vault.
    function _baseWithdraw(
        uint256 assets,
        uint256 shares,
        address owner,
        address receiver,
        address allowanceTarget,
        bool asAToken,
        uint256 underlyingBalance,
        uint256 atokenBalance
    ) private {
        // spend allowance if necessary
        if (allowanceTarget != owner) {
            _spendAllowance(owner, allowanceTarget, shares);
        }
        // burn shares
        _burn(owner, shares);
        // handle withdraw and transfer
        // if withdrawing the atoken
        if (asAToken) {
            // if we don't have enough atokens
            if(atokenBalance < assets) {
                // calculate amount needed
                uint256 supplyAmount = assets - atokenBalance;
                // supply to sake pool
                IPool(_sakePool).supply(_underlying, supplyAmount, address(this), _referralCode);
            }
            // transfer the atoken
            IERC20(_atoken).transfer(receiver, assets);
            // rebalance if necessary
            _rebalance();
        }
        // if withdrawing the underlying
        else {
            // if we don't have any underlying
            if(underlyingBalance == 0) {
                // withdraw directly from pool to receiver
                IPool(_sakePool).withdraw(_underlying, assets, receiver);
            }
            // if we have enough underlying
            else if(underlyingBalance >= assets) {
                // transfer underlying to receiver
                IERC20(_underlying).transfer(receiver, assets);
                // rebalance if necessary
                _rebalance();
            }
            // if we have some underlying but not enough
            else {
                // calculate amount needed
                uint256 withdrawAmount = assets - underlyingBalance;
                // withdraw from sake pool
                IPool(_sakePool).withdraw(_underlying, withdrawAmount, address(this));
                // transfer underlying to receiver
                IERC20(_underlying).transfer(receiver, assets);
            }
        }
        // emit event
        emit Withdraw(allowanceTarget, receiver, owner, assets, shares);
    }
    
    /// @notice Rebalances this vaults positions.
    /// It will attempt to supply as much underlying to atoken and hold any underlying it cannot supply.
    function _rebalance() internal {
        // get underlying balance
        uint256 supplyAmount = IERC20(_underlying).balanceOf(address(this));
        // do nothing if no balance
        if(supplyAmount == 0) return;
        // try supplying. this should succeed in most cases
        try IPool(_sakePool).supply(_underlying, supplyAmount, address(this), _referralCode) {
            // return if successful
            return;
        }
        catch {}
        // if the first supply failed, try to supply 1 wei
        // this is needed to update the pool reserve state
        try IPool(_sakePool).supply(_underlying, 1, address(this), _referralCode) {}
        catch {
            // return if this also failed
            return;
        }
        // get new supply amount
        // this is more accurate because the reserves have been updated
        supplyAmount = Math.min(supplyAmount-1, _maxAssetsSuppliableToSake());
        // do nothing if no suppliable amount
        // in this case the pool is frozen, paused, deactivated, or has reached supply cap
        if(supplyAmount == 0) return;
        // try to supply again
        try IPool(_sakePool).supply(_underlying, supplyAmount, address(this), _referralCode) {}
        catch {}
    }

    /***************************************
    INTERNAL VIEW FUNCTIONS
    ***************************************/

    /// @notice Gets info about the vault and its token holdings.
    /// @return underlyingBalance The balance of the underlying token.
    /// @return atokenBalance The balance of the atoken.
    /// @return ta The adjusted total assets to be used in conversions.
    /// @return ts The adjusted total supply to be used in conversions.
    function _getVaultHoldings() private view returns (
        uint256 underlyingBalance,
        uint256 atokenBalance,
        uint256 ta,
        uint256 ts
    ) {
        underlyingBalance = IERC20(_underlying).balanceOf(address(this));
        atokenBalance = IERC20(_atoken).balanceOf(address(this));
        ta = underlyingBalance + atokenBalance + 1;
        ts = totalSupply() + 10 ** _decimalsOffset();
    }

    /// @notice Gets the maximum amount of assets that can be supplied to Sake.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @dev It does not factor in the balances of this contract.
    /// @return assets The maximum amount of assets that can be supplied to Sake.
    function _maxAssetsSuppliableToSake() internal view returns (uint256 assets) {
        // returns 0 if reserve is not active, or is frozen or paused
        // returns max uint256 value if supply cap is 0 (not capped)
        // returns supply cap - current amount supplied as max suppliable if there is a supply cap for this reserve

        AaveDataTypes.ReserveData memory reserveData = IPool(_sakePool).getReserveData(_underlying);

        uint256 reserveConfigMap = reserveData.configuration.data;
        uint256 supplyCap = (reserveConfigMap & ~ReserveConfiguration.SUPPLY_CAP_MASK) >> ReserveConfiguration.SUPPLY_CAP_START_BIT_POSITION;

        if (
            (reserveConfigMap & ~ReserveConfiguration.ACTIVE_MASK == 0) ||
            (reserveConfigMap & ~ReserveConfiguration.FROZEN_MASK != 0) ||
            (reserveConfigMap & ~ReserveConfiguration.PAUSED_MASK != 0)
        ) {
            return 0;
        } else if (supplyCap == 0) {
            return type(uint256).max;
        } else {
            // Reserve's supply cap - current amount supplied
            // See similar logic in Aave v3 ValidationLogic library, in the validateSupply function
            // https://github.com/aave/aave-v3-core/blob/a00f28e3ad7c0e4a369d8e06e0ac9fd0acabcab7/contracts/protocol/libraries/logic/ValidationLogic.sol#L71-L78
            uint256 currentSupply = WadRayMath.rayMul(
                (IAToken(_atoken).scaledTotalSupply() + uint256(reserveData.accruedToTreasury)),
                reserveData.liquidityIndex
            );
            uint256 supplyCapWithDecimals = supplyCap * 10 ** decimals();
            return supplyCapWithDecimals > currentSupply ? supplyCapWithDecimals - currentSupply : 0;
        }
    }

    /// @notice Gets the maximum amount of assets that can be withdrawn from Sake.
    /// @dev It takes Sake Pool limitations into consideration. It may not be accurate to the current block because the pool reserve is cached.
    /// @dev It does not factor in the balances of this contract.
    /// @return assets The maximum amount of assets that can be withdrawn from Sake.
    function _maxAssetsWithdrawableFromSake() internal view returns (uint256 assets) {
        // returns 0 if reserve is not active, or is paused
        // otherwise, returns available liquidity

        AaveDataTypes.ReserveData memory reserveData = IPool(_sakePool).getReserveData(_underlying);

        uint256 reserveConfigMap = reserveData.configuration.data;

        if ((reserveConfigMap & ~ReserveConfiguration.ACTIVE_MASK == 0) || (reserveConfigMap & ~ReserveConfiguration.PAUSED_MASK != 0)) {
            return 0;
        } else {
            return IERC20(_underlying).balanceOf(_atoken);
        }
    }
}
