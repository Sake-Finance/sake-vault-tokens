/* global describe it before ethers */

import hre from "hardhat";
const { ethers } = hre;
const { provider } = ethers;
import { BigNumber as BN, BigNumberish } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
const { expect, assert } = chai;
import fs from "fs";

import { MockERC20, SakeATokenVault, SakeProxyAdmin, SakeATokenVaultFactory, IPool, Multicall3, IPoolConfigurator } from "./../typechain-types";

import { isDeployed, expectDeployed } from "./../scripts/utils/expectDeployed";
import { toBytes32, manipulateERC20BalanceOf } from "./../scripts/utils/setStorage";
import { getNetworkSettings } from "../scripts/utils/getNetworkSettings";
import { decimalsToAmount } from "../scripts/utils/price";
import { leftPad, rightPad } from "../scripts/utils/strings";
import { deployContract } from "../scripts/utils/deployContract";
import L1DataFeeAnalyzer from "../scripts/utils/L1DataFeeAnalyzer";
import { getSelectors, FacetCutAction, calcSighash, calcSighashes, getCombinedAbi } from "./../scripts/utils/diamond"
import { expectInRange } from "../scripts/utils/test";
import { JsonRpcSigner } from "@ethersproject/providers";

const { AddressZero, WeiPerEther, MaxUint256, Zero } = ethers.constants;
const { formatUnits } = ethers.utils;

const Bytes32Zero = toBytes32(0);
const WeiPerUsdc = BN.from(1_000_000); // 6 decimals
const SecondsPerDay = 86400;
const SecondsPerHour = 3600;

const AAVE_ACTIVE_MASK = BN.from("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFFFFFFFFFF");
const AAVE_FROZEN_MASK = BN.from("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFDFFFFFFFFFFFFFF");
const AAVE_PAUSED_MASK = BN.from("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFFFFFFFFFFF");
const AAVE_SUPPLY_CAP_MASK = BN.from("0xFFFFFFFFFFFFFFFFFFFFFFFFFF000000000FFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
const AAVE_SUPPLY_CAP_BIT_POSITION = 116;

describe("SakeATokenVault-usdce-edge-frozen", function () {
  let deployer: SignerWithAddress;
  let owner: SignerWithAddress;
  let strategyManager: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  let user4: SignerWithAddress;
  let user5: SignerWithAddress;
  let user6: SignerWithAddress;
  let user7: SignerWithAddress;
  let timelockImpersonated: JsonRpcSigner;

  let multicall3: Multicall3;
  let vault: SakeATokenVault;
  let vaultImplementation: SakeATokenVault;
  let usdce: MockERC20;
  let ausdce: MockERC20;
  let wausdce: SakeATokenVault;
  let pool: IPool;
  let otherToken: MockERC20;
  let poolConfigurator: IPoolConfigurator;

  let proxyAdmin: SakeProxyAdmin;
  let vaultFactory: SakeATokenVaultFactory;

  const MULTICALL3_ADDRESS = "0xB981161Be7D05d7a291Ffa5CE32c2771422De385";
  const USDCE_ADDRESS = "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369"
  const AUSDCE_ADDRESS = "0x4491B60c8fdD668FcC2C4dcADf9012b3fA71a726"
  const POOL_ADDRESS = "0x3C3987A310ee13F7B8cBBe21D97D4436ba5E4B5f"
  const AAVE_POOL_ADDRESSES_PROVIDER_ADDRESS = "0x73a35ca19Da0357651296c40805c31585f19F741"
  const TIMELOCK_ADDRESS = "0xAF4c640E8e15Ff2cd7fB7645Ddd9861882cFeC28"; // TimeLock
  const POOL_CONFIGURATOR_ADDRESS = "0xaB9Cf2CEae8D559097e99e28E89A053c8Bca1a81"; // PoolConfigurator

  const referralCode = BN.from(0)
  const referralCode2 = BN.from(2)

  let chainID: number;
  let networkSettings: any;
  let snapshot: BN;

  let l1DataFeeAnalyzer = new L1DataFeeAnalyzer();

  before(async function () {
    [deployer, owner, strategyManager, user1, user2, user3, user4, user5, user6, user7] = await ethers.getSigners();
    chainID = (await provider.getNetwork()).chainId;
    networkSettings = getNetworkSettings(chainID);
    if(!networkSettings.isTestnet) throw new Error("Do not run tests on production networks");
    snapshot = await provider.send("evm_snapshot", []);
    await deployer.sendTransaction({to:deployer.address}); // for some reason this helps solidity-coverage

    const blockNumber = 4591800; // later than the latest needed contract deployment
    // Run tests against forked network
    await hre.network.provider.request({
        method: "hardhat_reset",
        params: [
            {
                forking: {
                    jsonRpcUrl: process.env.SONEIUM_URL,
                    blockNumber,
                },
            },
        ],
    });


    await expectDeployed(MULTICALL3_ADDRESS)
    await expectDeployed(USDCE_ADDRESS)
    await expectDeployed(AUSDCE_ADDRESS)
    await expectDeployed(POOL_ADDRESS)
    await expectDeployed(AAVE_POOL_ADDRESSES_PROVIDER_ADDRESS)
    await expectDeployed(TIMELOCK_ADDRESS)
    await expectDeployed(POOL_CONFIGURATOR_ADDRESS)

    multicall3 = await ethers.getContractAt("Multicall3", MULTICALL3_ADDRESS) as Multicall3;
    usdce = await ethers.getContractAt("MockERC20", USDCE_ADDRESS) as MockERC20;
    ausdce = await ethers.getContractAt("MockERC20", AUSDCE_ADDRESS) as MockERC20;
    pool = await ethers.getContractAt("IPool", POOL_ADDRESS) as IPool;
    poolConfigurator = await ethers.getContractAt("IPoolConfigurator", POOL_CONFIGURATOR_ADDRESS) as IPoolConfigurator;

    await user1.sendTransaction({to: TIMELOCK_ADDRESS, value: WeiPerEther})

    await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [TIMELOCK_ADDRESS],
    });
    timelockImpersonated = provider.getSigner(TIMELOCK_ADDRESS);
  });

  after(async function () {
    await provider.send("evm_revert", [snapshot]);
  });

  describe("deploy SakeATokenVault implementation", function () {
    it("can deploy SakeATokenVault implementation", async function () {
      vaultImplementation = await deployContract(deployer, "SakeATokenVault", [USDCE_ADDRESS, AUSDCE_ADDRESS, POOL_ADDRESS, referralCode]) as SakeATokenVault;
      await expectDeployed(vaultImplementation.address);
      l1DataFeeAnalyzer.register("deploy SakeATokenVault implementation", vaultImplementation.deployTransaction);
    })
  })

  describe("deploy SakeProxyAdmin", function () {
    it("can deploy SakeProxyAdmin", async function () {
      proxyAdmin = await deployContract(deployer, "SakeProxyAdmin", [owner.address]) as SakeProxyAdmin;
      await expectDeployed(proxyAdmin.address);
      l1DataFeeAnalyzer.register("deploy SakeProxyAdmin", proxyAdmin.deployTransaction);
      expect(await proxyAdmin.owner()).eq(owner.address)
    })
  })

  describe("deploy SakeATokenVaultFactory", function () {
    it("can deploy SakeATokenVaultFactory", async function () {
      vaultFactory = await deployContract(deployer, "SakeATokenVaultFactory", [owner.address]) as SakeATokenVaultFactory;
      await expectDeployed(vaultFactory.address);
      l1DataFeeAnalyzer.register("deploy SakeATokenVaultFactory", vaultFactory.deployTransaction);
      expect(await vaultFactory.owner()).eq(owner.address)
    })
  })

  describe("deploy SakeATokenVault proxy", function () {
    let proxyAddress: string
    it("mint usdce", async function () {
      await setUsdceBalance(owner.address, WeiPerUsdc.mul(10000));
      await usdce.connect(owner).approve(vaultFactory.address, MaxUint256)
    })
    it("can precalculate proxy address", async function () {
      proxyAddress = await vaultFactory.connect(owner).callStatic.createVault(
        vaultImplementation.address,
        proxyAdmin.address,
        owner.address,
        toBytes32(0),
        "ERC4626-Wrapped Sake aUSDC.e",
        "waUSDC.e",
        false,
        1
      )
      expect(proxyAddress).not.eq(AddressZero)
    })
    it("can deploy vault proxy", async function () {
      expect(await isDeployed(proxyAddress)).to.be.false
      let tx = await vaultFactory.connect(owner).createVault(
        vaultImplementation.address,
        proxyAdmin.address,
        owner.address,
        toBytes32(0),
        "ERC4626-Wrapped Sake aUSDC.e",
        "waUSDC.e",
        false,
        WeiPerUsdc.mul(100)
      )
      expect(await isDeployed(proxyAddress)).to.be.true
      await expect(tx).to.emit(vaultFactory, "VaultCreated").withArgs(proxyAddress)
      wausdce = await ethers.getContractAt("SakeATokenVault", proxyAddress) as SakeATokenVault
    })
  })

  describe("interest", function () {
    it("earns interest over time", async function () {
      let vaultStatsLast = await getVaultStats(wausdce)
      for(let i = 0; i < 1; i++) {
        // advance time
        await provider.send("evm_increaseTime", [SecondsPerDay]);
        await wausdce.connect(owner).transfer(owner.address, 1)
        // check updated stats
        let vaultStatsNext = await getVaultStats(wausdce)
        expect(vaultStatsNext.totalSupply).eq(vaultStatsLast.totalSupply)
        expect(vaultStatsNext.usdceBalance).eq(vaultStatsLast.usdceBalance)
        expect(vaultStatsNext.ausdceBalance).gt(vaultStatsLast.ausdceBalance)
        expect(vaultStatsNext.wausdceBalance).eq(vaultStatsLast.wausdceBalance)
        expect(vaultStatsNext.totalAssets).eq(vaultStatsNext.usdceBalance.add(vaultStatsNext.ausdceBalance))
        expect(vaultStatsNext.convertToAssets).gt(vaultStatsLast.convertToAssets)
        expect(vaultStatsNext.convertToShares).lt(vaultStatsLast.convertToShares)
        vaultStatsLast = vaultStatsNext
      }
    })
  })

  context("when reserve has been frozen in pool", function () {
    describe("freeze reserve", function () {
      it("can freeze reserve", async function () {
        let reserveConfig0 = await pool.getConfiguration(USDCE_ADDRESS)
        //console.log(`reserveConfig0`)
        //console.log(reserveConfig0)
        //data: BigNumber { value: "5708991601591336895850193568432546442664346656076" }
        //console.log(reserveConfig0.data)
        //console.log(reserveConfig0.data.toHexString())
        //console.log(reserveConfig0.data.and(AAVE_FROZEN_MASK.xnor(MaxUint256))))
        //console.log(`frozen mask`)
        //console.log(AAVE_FROZEN_MASK.toHexString())
        //let isActive0 = reserveConfig0.data.and(AAVE_FROZEN_MASK.xnor(MaxUint256)))
        //console.log(`mask 2`)
        let mask2 = MaxUint256.sub(AAVE_FROZEN_MASK)
        //console.log(mask2.toHexString())
        //console.log(`isFrozen0`)
        let isFrozenBytes0 = reserveConfig0.data.and(mask2)
        let isFrozen0 = isFrozenBytes0.gt(0)
        //console.log(isFrozenBytes0.toHexString())
        //console.log(isFrozen0)
        expect(isFrozen0).eq(false)

        /*
reserveConfig0
BigNumber { value: "5708991601591336895850193568432546442664346656076" }
0x                      03e80009896800004c4b4005dca50629cc1f401d4c
frozen mask
0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFDFFFFFFFFFFFFFF
mask 2
0x                                                0200000000000000
isActive0
0x00

new config
0x                      03e80009896800004c4b4005dca70629cc1f401d4c
        */
        //let isActive0 = reserveConfig0.

        //let newConfig = reserveConfig0.data.or(AAVE_FROZEN_MASK)
        let newConfig = reserveConfig0.data.or(mask2)
        //console.log(`new config`)
        //console.log(newConfig.toHexString())
        let configuration = { data: newConfig }
        //console.log(`setting config`)
        //let tx = await pool.connect(timelockImpersonated).setConfiguration(USDCE_ADDRESS, configuration)
        let tx = await poolConfigurator.connect(timelockImpersonated).setReserveFreeze(USDCE_ADDRESS, true)
        //console.log(`config set`)
        let reserveConfig1 = await pool.getConfiguration(USDCE_ADDRESS)
        //console.log(`reserveConfig1`)
        //console.log(reserveConfig1)
        //data: BigNumber { value: "
        //console.log(reserveConfig1.data)
        //console.log(reserveConfig1.data.toHexString())
        expect(reserveConfig1.data).eq(newConfig)
        //console.log(reserveConfig1.data.and(AAVE_FROZEN_MASK.xnor(MaxUint256))))
        //console.log(`frozen mask`)
        //console.log(AAVE_FROZEN_MASK.toHexString())
        //let isActive0 = reserveConfig1.data.and(AAVE_FROZEN_MASK.xnor(MaxUint256)))
        //console.log(`mask 2`)
        //let mask2 = MaxUint256.sub(AAVE_FROZEN_MASK)
        //console.log(mask2.toHexString())
        //console.log(`isFrozen1`)
        let isFrozenBytes1 = reserveConfig1.data.and(mask2)
        let isFrozen1 = isFrozenBytes1.gt(0)
        //console.log(isFrozenBytes1.toHexString())
        //console.log(isFrozen1)
        expect(isFrozen1).eq(true)
      })
    })
    describe("maxAssetsSuppliableToSake", function () {
      it("maxAssetsSuppliableToSake is zero", async function () {
        expect(await wausdce.maxAssetsSuppliableToSake()).eq(0)
      })
    })
    describe("maxAssetsWithdrawableFromSake", function () {
      it("maxAssetsWithdrawableFromSake not affected by freeze", async function () {
        expect(await wausdce.maxAssetsWithdrawableFromSake()).gt(0)
        expect(await wausdce.maxAssetsWithdrawableFromSake()).eq(await usdce.balanceOf(ausdce.address))
      })
    })
    describe("deposit", function () {
      it("will deposit and hold as underlying", async function () {
        await setUsdceBalance(user1.address, WeiPerUsdc.mul(10000))
        await usdce.connect(user1).approve(wausdce.address, MaxUint256)

        let vaultStats0 = await getVaultStats(wausdce)
        let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
        let depositAssetsAmount = WeiPerUsdc.mul(1000)
        let expectedSharesAmount = vaultStats0.convertToShares.mul(1000).div(1000)
        let expectedSharesAmount2 = await wausdce.previewDeposit(depositAssetsAmount)

        let tx = await wausdce.connect(user1).deposit(depositAssetsAmount, user1.address)
        
        let receipt = await tx.wait()
        let events = receipt.events
        let depositEvents = events?.filter(x => x.event == "Deposit")
        expect(depositEvents).to.not.be.null
        expect(depositEvents.length).eq(1)
        let depositEvent = depositEvents[0]
        
        let actualSharesAmount = depositEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 10)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 10)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(user1.address, wausdce.address, depositAssetsAmount)
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user1.address, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Deposit").withArgs(user1.address, user1.address, depositAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce)
        expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance.add(depositAssetsAmount))
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance, 10)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(depositAssetsAmount), 10)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(actualSharesAmount))
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
        
        let tokenBalances1 = await getTokenBalances(user1.address, true, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.sub(depositAssetsAmount))
        expect(tokenBalances1.ausdceBalance).eq(tokenBalances0.ausdceBalance)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.add(actualSharesAmount))

        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).lt(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(vaultStats0.ausdceBalance)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expect(tokenBalances1.maxRedeemAsATokens).lt(tokenBalances1.wausdceBalance)
        expectInRange(tokenBalances1.maxRedeemAsATokens, vaultStats1.ausdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)
      })
    })
    describe("withdrawATokens", function () {
      it("cannot withdrawATokens if it needs to supply", async function () {
        let vaultStats0 = await getVaultStats(wausdce)
        let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
        let withdrawAssetsAmount = tokenBalances0.wausdceBalance.mul(vaultStats0.totalAssets).div(vaultStats0.totalSupply)
        await expect(wausdce.connect(user1).withdrawATokens(withdrawAssetsAmount, user1.address, user1.address)).to.be.revertedWith("28") // RESERVE_FROZEN
      })
      it("can withdrawATokens if it doesnt need to supply", async function () {
        let vaultStats0 = await getVaultStats(wausdce)
        let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
        let withdrawAssetsAmount = WeiPerUsdc//.mul(vaultStats0.totalAssets).div(vaultStats0.totalSupply)
        let expectedSharesAmount = vaultStats0.convertToShares.mul(1).div(1000)
        let expectedSharesAmount2 = await wausdce.previewWithdraw(withdrawAssetsAmount)
        let expectedSharesAmount3 = await wausdce.previewWithdrawAsATokens(withdrawAssetsAmount)
        expect(expectedSharesAmount3).eq(expectedSharesAmount2)

        let tx = await wausdce.connect(user1).withdrawATokens(withdrawAssetsAmount, user1.address, user1.address)
        
        let receipt = await tx.wait()
        let events = receipt.events
        let withdrawEvents = events?.filter(x => x.event == "Withdraw")
        expect(withdrawEvents).to.not.be.null
        expect(withdrawEvents.length).eq(1)
        let withdrawEvent = withdrawEvents[0]

        let actualSharesAmount = withdrawEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 10)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 10)
        await expect(tx).to.emit(ausdce, "Transfer").withArgs(wausdce.address, user1.address, withdrawAssetsAmount)
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user1.address, user1.address, user1.address, withdrawAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce)
        expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.sub(withdrawAssetsAmount), 10)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(withdrawAssetsAmount), 10)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(actualSharesAmount))
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
        
        let tokenBalances1 = await getTokenBalances(user1.address, true, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance)
        expectInRange(tokenBalances1.ausdceBalance, tokenBalances0.ausdceBalance.add(withdrawAssetsAmount), 10)
        expectInRange(tokenBalances1.wausdceBalance, tokenBalances0.wausdceBalance.sub(expectedSharesAmount))

        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).lt(tokenBalances1.maxWithdraw)
        expectInRange(tokenBalances1.maxWithdrawAsATokens, vaultStats0.ausdceBalance.sub(withdrawAssetsAmount), 10)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expect(tokenBalances1.maxRedeemAsATokens).lt(tokenBalances1.wausdceBalance)
        expectInRange(tokenBalances1.maxRedeemAsATokens, vaultStats1.ausdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)
      })
    })
    describe("unfreeze reserve", function () {
      it("can unfreeze reserve", async function () {
        let reserveConfig0 = await pool.getConfiguration(USDCE_ADDRESS)
        let mask2 = MaxUint256.sub(AAVE_FROZEN_MASK)
        let isFrozenBytes0 = reserveConfig0.data.and(mask2)
        let isFrozen0 = isFrozenBytes0.gt(0)
        expect(isFrozen0).eq(true)

        //let newConfig = reserveConfig0.data.or(mask2)
        //let configuration = { data: newConfig }
        let tx = await poolConfigurator.connect(timelockImpersonated).setReserveFreeze(USDCE_ADDRESS, false)
        let reserveConfig1 = await pool.getConfiguration(USDCE_ADDRESS)
        //expect(reserveConfig1.data).eq(newConfig)
        let isFrozenBytes1 = reserveConfig1.data.and(mask2)
        let isFrozen1 = isFrozenBytes1.gt(0)
        expect(isFrozen1).eq(false)
      })
    })
  })

  context("when reserve has been unfrozen in pool", function () {
    describe("withdrawATokens", function () {
      it("can withdrawATokens even if it needs to supply", async function () {
        let vaultStats0 = await getVaultStats(wausdce)
        let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
        let withdrawAssetsAmount = tokenBalances0.wausdceBalance.mul(vaultStats0.totalAssets).div(vaultStats0.totalSupply).sub(WeiPerUsdc.mul(1))
        let expectedSharesAmount = vaultStats0.convertToShares.mul(withdrawAssetsAmount).div(WeiPerUsdc.mul(1000))
        let expectedSharesAmount2 = await wausdce.previewWithdraw(withdrawAssetsAmount)
        let expectedSharesAmount3 = await wausdce.previewWithdrawAsATokens(withdrawAssetsAmount)
        expect(expectedSharesAmount3).eq(expectedSharesAmount2)

        let tx = await wausdce.connect(user1).withdrawATokens(withdrawAssetsAmount, user1.address, user1.address)
        
        let receipt = await tx.wait()
        let events = receipt.events
        let withdrawEvents = events?.filter(x => x.event == "Withdraw")
        expect(withdrawEvents).to.not.be.null
        expect(withdrawEvents.length).eq(1)
        let withdrawEvent = withdrawEvents[0]

        let actualSharesAmount = withdrawEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 10)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 10)
        await expect(tx).to.emit(ausdce, "Transfer").withArgs(wausdce.address, user1.address, withdrawAssetsAmount)
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user1.address, user1.address, user1.address, withdrawAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce)
        expect(vaultStats1.usdceBalance).eq(0) // all rebalanced
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(vaultStats0.usdceBalance).sub(withdrawAssetsAmount), 10)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(withdrawAssetsAmount), 10)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(actualSharesAmount))
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
        
        let tokenBalances1 = await getTokenBalances(user1.address, true, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance)
        expectInRange(tokenBalances1.ausdceBalance, tokenBalances0.ausdceBalance.add(withdrawAssetsAmount), 10)
        expectInRange(tokenBalances1.wausdceBalance, tokenBalances0.wausdceBalance.sub(expectedSharesAmount))

        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
      })
    })
  })

  /*
  context("when reserve has been deactivated in pool", function () {
    describe("deactivate reserve", function () {
      it("can deactivate reserve", async function () {
        let reserveConfig0 = await pool.getConfiguration(USDCE_ADDRESS)
        console.log(`reserveConfig0`)
        console.log(reserveConfig0)
        console.log(reserveConfig0.data.toHexString())
        console.log(`active mask`)
        console.log(AAVE_ACTIVE_MASK.toHexString())
        console.log(`mask 3`)
        let mask3 = MaxUint256.sub(AAVE_ACTIVE_MASK)
        console.log(mask3.toHexString())
        console.log(`isActive0`)
        let isActiveBytes0 = reserveConfig0.data.and(mask3)
        let isActive0 = isActiveBytes0.gt(0)
        console.log(isActiveBytes0.toHexString())
        console.log(isActive0)
        expect(isActive0).eq(true)
        
        let newConfig = reserveConfig0.data.or(mask3)
        console.log(`new config`)
        console.log(newConfig.toHexString())
        
        // cannot deactivate a reserve with liquidity. needs to be tested on a fresh asset
        // reverted with reason string '18'
        //RESERVE_LIQUIDITY_NOT_ZERO = '18'; // 'The liquidity of the reserve needs to be 0'
        let tx = await poolConfigurator.connect(timelockImpersonated).setReserveActive(USDCE_ADDRESS, false)
        let reserveConfig1 = await pool.getConfiguration(USDCE_ADDRESS)
        console.log(`reserveConfig1`)
        console.log(reserveConfig1.data.toHexString())
        expect(reserveConfig1.data).eq(newConfig)
        console.log(`active mask`)
        console.log(AAVE_ACTIVE_MASK.toHexString())
        console.log(`mask 3`)
        console.log(mask3.toHexString())
        console.log(`isActive0`)
        let isActiveBytes1 = reserveConfig1.data.and(mask3)
        let isActive1 = isActiveBytes1.gt(0)
        console.log(isActiveBytes1.toHexString())
        console.log(isActive1)
        expect(isActive1).eq(false)
        
      })
    })
  })
  */

  context("when reserve has been paused in pool", function () {
    describe("pause reserve", function () {
      it("can pause reserve", async function () {
        let reserveConfig0 = await pool.getConfiguration(USDCE_ADDRESS)
        console.log(`reserveConfig0`)
        console.log(reserveConfig0)
        console.log(reserveConfig0.data.toHexString())
        console.log(`paused mask`)
        console.log(AAVE_PAUSED_MASK.toHexString())
        console.log(`mask 4`)
        let mask4 = MaxUint256.sub(AAVE_PAUSED_MASK)
        console.log(mask4.toHexString())
        console.log(`isPaused0`)
        let isPausedBytes0 = reserveConfig0.data.and(mask4)
        let isPaused0 = isPausedBytes0.gt(0)
        console.log(isPausedBytes0.toHexString())
        console.log(isPaused0)
        expect(isPaused0).eq(false)

        let newConfig = reserveConfig0.data.or(mask4)
        console.log(`new config`)
        console.log(newConfig.toHexString())

        let tx = await poolConfigurator.connect(timelockImpersonated).setReservePause(USDCE_ADDRESS, true)
        let reserveConfig1 = await pool.getConfiguration(USDCE_ADDRESS)
        console.log(`reserveConfig1`)
        console.log(reserveConfig1.data.toHexString())
        expect(reserveConfig1.data).eq(newConfig)
        console.log(`paused mask`)
        console.log(AAVE_ACTIVE_MASK.toHexString())
        console.log(`mask 4`)
        console.log(mask4.toHexString())
        console.log(`isPaused0`)
        let isPausedBytes1 = reserveConfig1.data.and(mask4)
        let isPaused1 = isPausedBytes1.gt(0)
        console.log(isPausedBytes1.toHexString())
        console.log(isPaused1)
        expect(isPaused1).eq(true)
      })
    })
    describe("maxAssetsSuppliableToSake", function () {
      it("maxAssetsSuppliableToSake is zero", async function () {
        expect(await wausdce.maxAssetsSuppliableToSake()).eq(0)
      })
    })
    describe("maxAssetsWithdrawableFromSake", function () {
      it("maxAssetsWithdrawableFromSake is zero", async function () {
        expect(await wausdce.maxAssetsWithdrawableFromSake()).eq(0)
      })
    })
    describe("deposit", function () {
      it("will deposit and hold as underlying", async function () {
        await setUsdceBalance(user1.address, WeiPerUsdc.mul(10000))
        await usdce.connect(user1).approve(wausdce.address, MaxUint256)

        let vaultStats0 = await getVaultStats(wausdce)
        let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
        let depositAssetsAmount = WeiPerUsdc.mul(1000)
        let expectedSharesAmount = vaultStats0.convertToShares.mul(1000).div(1000)
        let expectedSharesAmount2 = await wausdce.previewDeposit(depositAssetsAmount)

        let tx = await wausdce.connect(user1).deposit(depositAssetsAmount, user1.address)
        
        let receipt = await tx.wait()
        let events = receipt.events
        let depositEvents = events?.filter(x => x.event == "Deposit")
        expect(depositEvents).to.not.be.null
        expect(depositEvents.length).eq(1)
        let depositEvent = depositEvents[0]
        
        let actualSharesAmount = depositEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 10)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 10)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(user1.address, wausdce.address, depositAssetsAmount)
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user1.address, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Deposit").withArgs(user1.address, user1.address, depositAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce)
        expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance.add(depositAssetsAmount))
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance, 10)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(depositAssetsAmount), 10)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(actualSharesAmount))
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
        
        let tokenBalances1 = await getTokenBalances(user1.address, true, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.sub(depositAssetsAmount))
        expectInRange(tokenBalances1.ausdceBalance, tokenBalances0.ausdceBalance, 10)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.add(actualSharesAmount))

        //expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdraw).eq(vaultStats1.usdceBalance)
        //expect(tokenBalances1.maxWithdrawAsATokens).lt(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(vaultStats1.ausdceBalance)
        //expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expectInRange(tokenBalances1.maxRedeem, vaultStats1.usdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)
        expect(tokenBalances1.maxRedeemAsATokens).lt(tokenBalances1.wausdceBalance)
        expectInRange(tokenBalances1.maxRedeemAsATokens, vaultStats1.ausdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)
      })
    })
    describe("depositATokens", function () {
      it("cannot depositATokens - cannot transfer atokens", async function () {
        expect(await ausdce.balanceOf(user1.address)).gte(WeiPerUsdc)
        await ausdce.connect(user1).approve(wausdce.address, MaxUint256)
        expect(await ausdce.allowance(user1.address, wausdce.address)).gte(WeiPerUsdc)

        //await wausdce.connect(user1).depositATokens(WeiPerUsdc, user1.address)
        await expect(wausdce.connect(user1).depositATokens(WeiPerUsdc, user1.address)).to.be.revertedWith("29") // RESERVE_PAUSED
      })
    })
    describe("withdrawATokens", function () {
      it("cannot withdrawATokens - cannot transfer atokens", async function () {
        //await wausdce.connect(user1).withdrawATokens(WeiPerUsdc, user1.address, user1.address)
        await expect(wausdce.connect(user1).withdrawATokens(WeiPerUsdc, user1.address, user1.address)).to.be.revertedWith("29") // RESERVE_PAUSED
      })
    })
    describe("withdraw", function () {
      it("can withdraw underlying if it doesn't need to withdraw from sake", async function () {
        let vaultStats0 = await getVaultStats(wausdce)
        let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
        let withdrawAssetsAmount = WeiPerUsdc
        expect(withdrawAssetsAmount).lte(tokenBalances0.usdceBalance)
        let expectedSharesAmount = withdrawAssetsAmount.mul(vaultStats0.totalSupply).div(vaultStats0.totalAssets)
        let expectedSharesAmount2 = await wausdce.previewWithdraw(withdrawAssetsAmount)

        let tx = await wausdce.connect(user1).withdraw(withdrawAssetsAmount, user1.address, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let withdrawEvents = events?.filter(x => x.event == "Withdraw")
        expect(withdrawEvents).to.not.be.null
        expect(withdrawEvents.length).eq(1)
        let withdrawEvent = withdrawEvents[0]

        let actualSharesAmount = withdrawEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 10)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 10)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(wausdce.address, user1.address, withdrawAssetsAmount) // withdraw from wausdce
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user1.address, user1.address, user1.address, withdrawAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce)
        expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance.sub(withdrawAssetsAmount))
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance, 10)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(withdrawAssetsAmount), 10)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(actualSharesAmount))
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
        
        let tokenBalances1 = await getTokenBalances(user1.address, true, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.add(withdrawAssetsAmount))
        expectInRange(tokenBalances1.ausdceBalance, tokenBalances0.ausdceBalance, 10)
        expectInRange(tokenBalances1.wausdceBalance, tokenBalances0.wausdceBalance.sub(expectedSharesAmount))
        //expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        //expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
        //expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        //expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)

        //expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdraw).eq(vaultStats1.usdceBalance)
        //expect(tokenBalances1.maxWithdrawAsATokens).lt(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(vaultStats1.ausdceBalance)
        //expectInRange(tokenBalances1.maxWithdrawAsATokens, vaultStats0.ausdceBalance.sub(withdrawAssetsAmount), 10)
        //expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        //expect(tokenBalances1.maxRedeemAsATokens).lt(tokenBalances1.wausdceBalance)
        expectInRange(tokenBalances1.maxRedeem, vaultStats1.usdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)
        expectInRange(tokenBalances1.maxRedeemAsATokens, vaultStats1.ausdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)
      })
      it("cannot withdraw underlying if needs to withdraw from sake", async function () {
        let vaultStats0 = await getVaultStats(wausdce)
        let withdrawAssetsAmount = vaultStats0.usdceBalance.add(1)
        await expect(wausdce.connect(user1).withdrawATokens(WeiPerUsdc, user1.address, user1.address)).to.be.revertedWith("29") // RESERVE_PAUSED
      })
    })
    describe("unpause reserve", function () {
      it("can unpause reserve", async function () {
        let reserveConfig0 = await pool.getConfiguration(USDCE_ADDRESS)
        console.log(`reserveConfig0`)
        console.log(reserveConfig0)
        console.log(reserveConfig0.data.toHexString())
        console.log(`paused mask`)
        console.log(AAVE_PAUSED_MASK.toHexString())
        console.log(`mask 4`)
        let mask4 = MaxUint256.sub(AAVE_PAUSED_MASK)
        console.log(mask4.toHexString())
        console.log(`isPaused0`)
        let isPausedBytes0 = reserveConfig0.data.and(mask4)
        let isPaused0 = isPausedBytes0.gt(0)
        console.log(isPausedBytes0.toHexString())
        console.log(isPaused0)
        expect(isPaused0).eq(true)

        //let newConfig = reserveConfig0.data.or(mask4)
        let newConfig = reserveConfig0.data.and(AAVE_PAUSED_MASK)
        console.log(`new config`)
        console.log(newConfig.toHexString())

        let tx = await poolConfigurator.connect(timelockImpersonated).setReservePause(USDCE_ADDRESS, false)
        let reserveConfig1 = await pool.getConfiguration(USDCE_ADDRESS)
        console.log(`reserveConfig1`)
        console.log(reserveConfig1.data.toHexString())
        expect(reserveConfig1.data).eq(newConfig)
        console.log(`paused mask`)
        console.log(AAVE_ACTIVE_MASK.toHexString())
        console.log(`mask 4`)
        console.log(mask4.toHexString())
        console.log(`isPaused0`)
        let isPausedBytes1 = reserveConfig1.data.and(mask4)
        let isPaused1 = isPausedBytes1.gt(0)
        console.log(isPausedBytes1.toHexString())
        console.log(isPaused1)
        expect(isPaused1).eq(false)
      })
    })
  })

  async function setUsdceBalance(address:string, amount:BigNumberish) {
    //let balanceOfSlot = await findERC20BalanceOfSlot(USDCE_ADDRESS)
    //console.log(`usdce balanceOf slot: ${balanceOfSlot}`)
    let balanceOfSlot = 9
    await manipulateERC20BalanceOf(USDCE_ADDRESS, balanceOfSlot, address, amount)
  }

  async function getVaultStats(vault: SakeATokenVault, log=true) {
    let calls = [
      {
          target: vault.address,
          allowFailure: false,
          callData: vault.interface.encodeFunctionData("totalSupply", [])
      },
      {
          target: USDCE_ADDRESS,
          allowFailure: false,
          callData: usdce.interface.encodeFunctionData("balanceOf", [vault.address])
      },
      {
        target: AUSDCE_ADDRESS,
        allowFailure: false,
        callData: ausdce.interface.encodeFunctionData("balanceOf", [vault.address])
      },
      {
          target: vault.address,
          allowFailure: false,
          callData: vault.interface.encodeFunctionData("balanceOf", [vault.address])
      },
      {
          target: vault.address,
          allowFailure: false,
          callData: vault.interface.encodeFunctionData("totalAssets", [])
      },
      {
          target: vault.address,
          allowFailure: false,
          callData: vault.interface.encodeFunctionData("convertToShares", [WeiPerUsdc.mul(1000)])
      },
      {
          target: vault.address,
          allowFailure: false,
          callData: vault.interface.encodeFunctionData("convertToAssets", [WeiPerUsdc.mul(1000)])
      },
      {
          target: vault.address,
          allowFailure: false,
          callData: vault.interface.encodeFunctionData("maxAssetsSuppliableToSake", [])
      },
      {
          target: vault.address,
          allowFailure: false,
          callData: vault.interface.encodeFunctionData("maxAssetsWithdrawableFromSake", [])
      },
    ]
    let returnData = await multicall3.callStatic.aggregate3(calls)
    let res = {
      totalSupply: BN.from(returnData[0].returnData),
      usdceBalance: BN.from(returnData[1].returnData),
      ausdceBalance: BN.from(returnData[2].returnData),
      wausdceBalance: BN.from(returnData[3].returnData),
      totalAssets: BN.from(returnData[4].returnData),
      convertToShares: BN.from(returnData[5].returnData),
      convertToAssets: BN.from(returnData[6].returnData),
      maxAssetsSuppliableToSake: BN.from(returnData[7].returnData),
      maxAssetsWithdrawableFromSake: BN.from(returnData[8].returnData),
    }
    if(log) {
      console.log(`Vault stats:`)
      console.log({
        totalSupply: formatUnits(res.totalSupply, 6),
        usdceBalance: formatUnits(res.usdceBalance, 6),
        ausdceBalance: formatUnits(res.ausdceBalance, 6),
        wausdceBalance: formatUnits(res.wausdceBalance, 6),
        totalAssets: formatUnits(res.totalAssets, 6),
        convertToShares: formatUnits(res.convertToShares, 6),
        convertToAssets: formatUnits(res.convertToAssets, 6),
        maxAssetsSuppliableToSake: formatUnits(res.maxAssetsSuppliableToSake, 6),
        maxAssetsWithdrawableFromSake: formatUnits(res.maxAssetsWithdrawableFromSake, 6),
      })
    }
    expect(res.totalAssets).gte(res.totalSupply)
    expect(res.totalAssets).eq(res.usdceBalance.add(res.ausdceBalance))
    expect(res.convertToAssets).gte(res.convertToShares)
    return res
  }

  async function getTokenBalances(address:string, log=true, addressName="") {
    let calls = [
      {
          target: USDCE_ADDRESS,
          allowFailure: false,
          callData: usdce.interface.encodeFunctionData("balanceOf", [address])
      },
      {
        target: AUSDCE_ADDRESS,
        allowFailure: false,
        callData: ausdce.interface.encodeFunctionData("balanceOf", [address])
      },
      {
          target: wausdce.address,
          allowFailure: false,
          callData: wausdce.interface.encodeFunctionData("balanceOf", [address])
      },
      {
          target: wausdce.address,
          allowFailure: false,
          callData: wausdce.interface.encodeFunctionData("maxDeposit", [address])
      },
      {
          target: wausdce.address,
          allowFailure: false,
          callData: wausdce.interface.encodeFunctionData("maxMint", [address])
      },
      {
          target: wausdce.address,
          allowFailure: false,
          callData: wausdce.interface.encodeFunctionData("maxWithdraw", [address])
      },
      {
          target: wausdce.address,
          allowFailure: false,
          callData: wausdce.interface.encodeFunctionData("maxWithdrawAsATokens", [address])
      },
      {
          target: wausdce.address,
          allowFailure: false,
          callData: wausdce.interface.encodeFunctionData("maxRedeem", [address])
      },
      {
          target: wausdce.address,
          allowFailure: false,
          callData: wausdce.interface.encodeFunctionData("maxRedeemAsATokens", [address])
      },
    ]
    let returnData = await multicall3.callStatic.aggregate3(calls)
    let res = {
      usdceBalance: BN.from(returnData[0].returnData),
      ausdceBalance: BN.from(returnData[1].returnData),
      wausdceBalance: BN.from(returnData[2].returnData),
      maxDeposit: BN.from(returnData[3].returnData),
      maxMint: BN.from(returnData[4].returnData),
      maxWithdraw: BN.from(returnData[5].returnData),
      maxWithdrawAsATokens: BN.from(returnData[6].returnData),
      maxRedeem: BN.from(returnData[7].returnData),
      maxRedeemAsATokens: BN.from(returnData[8].returnData),
    }
    if(log) {
      console.log(`Balances of ${addressName || address}:`)
      console.log({
        usdceBalance: formatUnits(res.usdceBalance, 6),
        ausdceBalance: formatUnits(res.ausdceBalance, 6),
        wausdceBalance: formatUnits(res.wausdceBalance, 6),
        maxWithdraw: formatUnits(res.maxWithdraw, 6),
        maxWithdrawAsATokens: formatUnits(res.maxWithdrawAsATokens, 6),
        maxRedeem: formatUnits(res.maxRedeem, 6),
        maxRedeemAsATokens: formatUnits(res.maxRedeemAsATokens, 6),
      })
    }
    expect(res.maxDeposit).eq(MaxUint256)
    expect(res.maxMint).eq(MaxUint256)
    return res
  }

  describe("L1 gas fees", function () {
    it("calculate", async function () {
      l1DataFeeAnalyzer.analyze()
    });
  });
});
