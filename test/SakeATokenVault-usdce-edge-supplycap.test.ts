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
import { expectInRange } from "../scripts/utils/test";

const { AddressZero, WeiPerEther, MaxUint256, Zero } = ethers.constants;
const { formatUnits } = ethers.utils;

const Bytes32Zero = toBytes32(0);
const WeiPerUsdc = BN.from(1_000_000); // 6 decimals
const SecondsPerDay = 86400;
const SecondsPerHour = 3600;

describe("SakeATokenVault-usdce-edge-supplycap", function () {
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

    otherToken = await deployContract(deployer, "MockERC20", ["OtherToken", "OTHER", 18]) as MockERC20;

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
      let vaultStatsLast = await getVaultStats(wausdce, false)
      for(let i = 0; i < 3; i++) {
        // advance time
        await provider.send("evm_increaseTime", [SecondsPerHour]);
        await wausdce.connect(owner).transfer(owner.address, 1)
        // check updated stats
        let vaultStatsNext = await getVaultStats(wausdce, false)
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
    it("can earn interest when transferring in atoken", async function () {
      await setUsdceBalance(user1.address, WeiPerUsdc.mul(10000));
      await usdce.connect(user1).approve(POOL_ADDRESS, MaxUint256)
      let transferAmount = WeiPerUsdc.mul(5)
      await pool.connect(user1).supply(USDCE_ADDRESS, transferAmount, user1.address, 0)
      let vaultStats0 = await getVaultStats(wausdce, false)
      await ausdce.connect(user1).transfer(wausdce.address, transferAmount)
      let vaultStats1 = await getVaultStats(wausdce, false)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(transferAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expect(vaultStats1.totalAssets).eq(vaultStats1.usdceBalance.add(vaultStats1.ausdceBalance))
      expect(vaultStats1.convertToAssets).gt(vaultStats0.convertToAssets)
      expect(vaultStats1.convertToShares).lt(vaultStats0.convertToShares)
    })
    it("can earn interest when transferring in underlying", async function () {
      let transferAmount = WeiPerUsdc.mul(5)
      let vaultStats0 = await getVaultStats(wausdce, false)
      await usdce.connect(user1).transfer(wausdce.address, transferAmount)
      let vaultStats1 = await getVaultStats(wausdce, false)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance.add(transferAmount))
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance, 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expect(vaultStats1.totalAssets).eq(vaultStats1.usdceBalance.add(vaultStats1.ausdceBalance))
      expect(vaultStats1.convertToAssets).gt(vaultStats0.convertToAssets)
      expect(vaultStats1.convertToShares).lt(vaultStats0.convertToShares)
    })
    it("maxWithdrawAsATokens accounts for underlying", async function () {
      let vaultStats = await getVaultStats(wausdce, false)
      let tokenBalances = await getTokenBalances(owner.address, false, "creator")
      expectInRange(tokenBalances.maxWithdrawAsATokens, vaultStats.totalAssets.mul(tokenBalances.wausdceBalance).div(vaultStats.totalSupply), 10)
      expect(tokenBalances.maxWithdrawAsATokens).eq(tokenBalances.maxWithdraw)
      expect(tokenBalances.maxWithdrawAsATokens).gt(vaultStats.usdceBalance)
      expect(tokenBalances.maxWithdrawAsATokens).gt(vaultStats.ausdceBalance)
    })
  })

  describe("rebalance() 1", function () {
    it("can rebalance", async function () {
      let vaultStats0 = await getVaultStats(wausdce, false)
      let tx = await wausdce.connect(user1).rebalance()
      let vaultStats1 = await getVaultStats(wausdce, false)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply)
      expect(vaultStats1.usdceBalance).eq(0)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(vaultStats0.usdceBalance), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expect(vaultStats1.totalAssets).eq(vaultStats1.usdceBalance.add(vaultStats1.ausdceBalance))
      expect(vaultStats1.convertToAssets).gte(vaultStats0.convertToAssets)
      expect(vaultStats1.convertToShares).lte(vaultStats0.convertToShares)
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)
    })
    it("rebalance with no underlying does nothing", async function () {
      let vaultStats0 = await getVaultStats(wausdce, false)
      let tx = await wausdce.connect(user1).rebalance()
      let vaultStats1 = await getVaultStats(wausdce, false)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply)
      expect(vaultStats1.usdceBalance).eq(0)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance, 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expect(vaultStats1.totalAssets).eq(vaultStats1.usdceBalance.add(vaultStats1.ausdceBalance))
      expect(vaultStats1.convertToAssets).gte(vaultStats0.convertToAssets)
      expect(vaultStats1.convertToShares).lte(vaultStats0.convertToShares)
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)
      await expect(tx).to.not.emit(usdce, "Transfer")
      await expect(tx).to.not.emit(ausdce, "Transfer")
      await expect(tx).to.not.emit(wausdce, "Transfer")
    })
  })

  context("when supply cap has been reached", function () {
    describe("deposit", function () {
      it("deposit to just below supply cap", async function () {
        await setUsdceBalance(user1.address, WeiPerUsdc.mul(10_000_000));
        await usdce.connect(user1).approve(wausdce.address, MaxUint256)
        let vaultStats0 = await getVaultStats(wausdce, false)
        let bufferAmount = WeiPerUsdc.mul(10)
        let depositAssetsAmount = vaultStats0.maxAssetsSuppliableToSake.sub(bufferAmount)
        let expectedSharesAmount = vaultStats0.convertToShares.mul(depositAssetsAmount).div(WeiPerUsdc.mul(1000))
        let expectedSharesAmount2 = await wausdce.previewDeposit(depositAssetsAmount)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")

        let tx = await wausdce.connect(user1).deposit(depositAssetsAmount, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let depositEvents = events?.filter(x => x.event == "Deposit")
        expect(depositEvents).to.not.be.null
        expect(depositEvents?.length).to.equal(1)
        let depositEvent = depositEvents[0]
        let actualSharesAmount = depositEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 10000)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 10000)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(user1.address, wausdce.address, depositAssetsAmount)
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user1.address, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Deposit").withArgs(user1.address, user1.address, depositAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats1.usdceBalance).eq(0)
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(depositAssetsAmount), 10)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(actualSharesAmount))
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(depositAssetsAmount), 10)
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)
        expect(vaultStats1.maxAssetsSuppliableToSake).lte(bufferAmount)

        let tokenBalances1 = await getTokenBalances(user1.address, false, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.sub(depositAssetsAmount))
        expectInRange(tokenBalances1.ausdceBalance, tokenBalances0.ausdceBalance, 10)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.add(actualSharesAmount))
        expectInRange(tokenBalances1.maxWithdraw, vaultStats1.totalAssets.mul(tokenBalances1.wausdceBalance).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
      })
      it("deposit past supply cap", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        let depositAssetsAmount = WeiPerUsdc.mul(10000)
        let expectedSharesAmount = vaultStats0.convertToShares.mul(depositAssetsAmount).div(WeiPerUsdc.mul(1000))
        let expectedSharesAmount2 = await wausdce.previewDeposit(depositAssetsAmount)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")

        let tx = await wausdce.connect(user1).deposit(depositAssetsAmount, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let depositEvents = events?.filter(x => x.event == "Deposit")
        expect(depositEvents).to.not.be.null
        expect(depositEvents?.length).to.equal(1)
        let depositEvent = depositEvents[0]
        let actualSharesAmount = depositEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 10000)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 10000)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(user1.address, wausdce.address, depositAssetsAmount)
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user1.address, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Deposit").withArgs(user1.address, user1.address, depositAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats1.usdceBalance).gt(0)
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(vaultStats0.maxAssetsSuppliableToSake), 1000)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(actualSharesAmount))
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(depositAssetsAmount), 1000)
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)
        expect(vaultStats1.maxAssetsSuppliableToSake).eq(0)

        let tokenBalances1 = await getTokenBalances(user1.address, false, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.sub(depositAssetsAmount))
        expectInRange(tokenBalances1.ausdceBalance, tokenBalances0.ausdceBalance, 10)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.add(actualSharesAmount))
        expectInRange(tokenBalances1.maxWithdraw, vaultStats1.totalAssets.mul(tokenBalances1.wausdceBalance).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(vaultStats1.ausdceBalance)
        expect(tokenBalances1.maxWithdrawAsATokens).lt(tokenBalances1.maxWithdraw)

        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        //expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(vaultStats1.ausdceBalance)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        //expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
        expectInRange(tokenBalances1.maxRedeemAsATokens, vaultStats1.ausdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)

        let supplyEvents = events?.filter(x => !!x.topics && !!x.topics.length && x.topics[0] == "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61")
        expect(supplyEvents).to.not.be.null
        expect(supplyEvents?.length).to.equal(2)
      })
    })
    describe("withdraw", function () {
      it("maxWithdraw with underlying balance and small wausdce balance", async function () {
        let vaultStats = await getVaultStats(wausdce, false)
        let tokenBalances = await getTokenBalances(owner.address, false, "creator")
        expectInRange(tokenBalances.maxWithdrawAsATokens, vaultStats.totalAssets.mul(tokenBalances.wausdceBalance).div(vaultStats.totalSupply), 10)
        expect(tokenBalances.maxWithdrawAsATokens).eq(tokenBalances.maxWithdraw)
        expect(vaultStats.usdceBalance).gte(tokenBalances.maxWithdraw)
      })
      it("can withdraw using just underlying", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")
        let withdrawAssetsAmount = WeiPerUsdc.mul(1)
        expect(withdrawAssetsAmount).lt(vaultStats0.usdceBalance)
        let expectedSharesAmount = vaultStats0.convertToShares.mul(withdrawAssetsAmount).div(WeiPerUsdc.mul(1000))
        let expectedSharesAmount2 = await wausdce.previewWithdraw(withdrawAssetsAmount)

        let tx = await wausdce.connect(user1).withdraw(withdrawAssetsAmount, user1.address, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let withdrawEvents = events?.filter(x => x.event == "Withdraw")
        expect(withdrawEvents).to.not.be.null
        expect(withdrawEvents.length).eq(1)
        let withdrawEvent = withdrawEvents[0]

        let actualSharesAmount = withdrawEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 1000)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 1000)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(wausdce.address, user1.address, withdrawAssetsAmount) // withdraw comes from wausdce
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user1.address, user1.address, user1.address, withdrawAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance.sub(withdrawAssetsAmount))
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance, 1000)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(withdrawAssetsAmount), 1000)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(actualSharesAmount))
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
        
        let tokenBalances1 = await getTokenBalances(user1.address, false, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.add(withdrawAssetsAmount))
        expect(tokenBalances1.ausdceBalance).eq(tokenBalances0.ausdceBalance)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.sub(actualSharesAmount))
        
        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(vaultStats1.ausdceBalance)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expectInRange(tokenBalances1.maxRedeemAsATokens, vaultStats1.ausdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)

      })
      it("can withdraw using underlying and atokens", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")
        let withdrawAssetsAmount = await wausdce.convertToAssets(tokenBalances0.wausdceBalance)
        let expectedSharesAmount = vaultStats0.convertToShares.mul(withdrawAssetsAmount).div(WeiPerUsdc.mul(1000))
        let expectedSharesAmount2 = await wausdce.previewWithdraw(withdrawAssetsAmount)

        let tx = await wausdce.connect(user1).withdraw(withdrawAssetsAmount, user1.address, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let withdrawEvents = events?.filter(x => x.event == "Withdraw")
        expect(withdrawEvents).to.not.be.null
        expect(withdrawEvents.length).eq(1)
        let withdrawEvent = withdrawEvents[0]

        let actualSharesAmount = withdrawEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 1000)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 1000)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(wausdce.address, user1.address, withdrawAssetsAmount) // withdraw comes from wausdce
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user1.address, user1.address, user1.address, withdrawAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats1.usdceBalance).eq(0)
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.sub(withdrawAssetsAmount).add(vaultStats0.usdceBalance), 1000)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(withdrawAssetsAmount), 1000)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(actualSharesAmount))
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
        
        let tokenBalances1 = await getTokenBalances(user1.address, false, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.add(withdrawAssetsAmount))
        expect(tokenBalances1.ausdceBalance).eq(tokenBalances0.ausdceBalance)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.sub(actualSharesAmount))
        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
      })
    })
    describe("mint", function () {
      it("mint to just below supply cap", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        let bufferAmount = WeiPerUsdc.mul(10)
        let mintSharesAmount = await wausdce.convertToShares(vaultStats0.maxAssetsSuppliableToSake.sub(bufferAmount))
        let expectedAssetsAmount = vaultStats0.convertToAssets.mul(mintSharesAmount).div(WeiPerUsdc.mul(1000))
        let expectedAssetsAmount2 = await wausdce.previewMint(mintSharesAmount)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")
        
        let tx = await wausdce.connect(user1).mint(mintSharesAmount, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let depositEvents = events?.filter(x => x.event == "Deposit")
        expect(depositEvents).to.not.be.null
        expect(depositEvents?.length).to.equal(1)
        let depositEvent = depositEvents[0]
        let actualAssetsAmount = depositEvent.args.assets
        expectInRange(actualAssetsAmount, expectedAssetsAmount, 60000)
        expectInRange(actualAssetsAmount, expectedAssetsAmount2, 60000)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(user1.address, wausdce.address, actualAssetsAmount)
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user1.address, mintSharesAmount)
        await expect(tx).to.emit(wausdce, "Deposit").withArgs(user1.address, user1.address, actualAssetsAmount, mintSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats1.usdceBalance).eq(0)
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(actualAssetsAmount), 10)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(mintSharesAmount))
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(actualAssetsAmount), 10)
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)
        expect(vaultStats1.maxAssetsSuppliableToSake).lte(bufferAmount)

        let tokenBalances1 = await getTokenBalances(user1.address, false, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.sub(actualAssetsAmount))
        expectInRange(tokenBalances1.ausdceBalance, tokenBalances0.ausdceBalance, 10)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.add(mintSharesAmount))
        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
      })
      it("mint past supply cap", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        let mintSharesAmount = WeiPerUsdc.mul(10000)
        let expectedAssetsAmount = vaultStats0.convertToAssets.mul(mintSharesAmount).div(WeiPerUsdc.mul(1000))
        let expectedAssetsAmount2 = await wausdce.previewMint(mintSharesAmount)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")

        let tx = await wausdce.connect(user1).mint(mintSharesAmount, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let depositEvents = events?.filter(x => x.event == "Deposit")
        expect(depositEvents).to.not.be.null
        expect(depositEvents?.length).to.equal(1)
        let depositEvent = depositEvents[0]
        let actualAssetsAmount = depositEvent.args.assets
        expectInRange(actualAssetsAmount, expectedAssetsAmount, 10000)
        expectInRange(actualAssetsAmount, expectedAssetsAmount2, 10000)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(user1.address, wausdce.address, actualAssetsAmount)
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user1.address, mintSharesAmount)
        await expect(tx).to.emit(wausdce, "Deposit").withArgs(user1.address, user1.address, actualAssetsAmount, mintSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats1.usdceBalance).gt(0)
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(vaultStats0.maxAssetsSuppliableToSake), 1000)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(mintSharesAmount))
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(actualAssetsAmount), 1000)
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)
        expect(vaultStats1.maxAssetsSuppliableToSake).eq(0)

        let tokenBalances1 = await getTokenBalances(user1.address, false, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.sub(actualAssetsAmount))
        expectInRange(tokenBalances1.ausdceBalance, tokenBalances0.ausdceBalance, 10)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.add(mintSharesAmount))

        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(vaultStats1.ausdceBalance)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expectInRange(tokenBalances1.maxRedeemAsATokens, vaultStats1.ausdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)

        let supplyEvents = events?.filter(x => !!x.topics && !!x.topics.length && x.topics[0] == "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61")
        expect(supplyEvents).to.not.be.null
        expect(supplyEvents?.length).to.equal(2)
      })
    })
    describe("redeem", function () {
      it("can redeem using just underlying", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")
        let redeemSharesAmount = WeiPerUsdc.mul(1)
        let expectedAssetsAmount = vaultStats0.convertToAssets.mul(redeemSharesAmount).div(WeiPerUsdc.mul(1000))
        let expectedAssetsAmount2 = await wausdce.previewRedeem(redeemSharesAmount)
        expect(expectedAssetsAmount).lt(vaultStats0.usdceBalance)
        let expectedAssetsAmount3 = await wausdce.previewRedeemAsATokens(redeemSharesAmount)
        expect(expectedAssetsAmount3).eq(expectedAssetsAmount2)

        let tx = await wausdce.connect(user1).redeem(redeemSharesAmount, user1.address, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let withdrawEvents = events?.filter(x => x.event == "Withdraw")
        expect(withdrawEvents).to.not.be.null
        expect(withdrawEvents.length).eq(1)
        let withdrawEvent = withdrawEvents[0]

        let actualAssetsAmount = withdrawEvent.args.assets
        expectInRange(actualAssetsAmount, expectedAssetsAmount, 10)
        expectInRange(actualAssetsAmount, expectedAssetsAmount2, 10)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(wausdce.address, user1.address, actualAssetsAmount) // withdraw comes from wausdce
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, redeemSharesAmount)
        await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user1.address, user1.address, user1.address, actualAssetsAmount, redeemSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance.sub(actualAssetsAmount))
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance, 1000)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(actualAssetsAmount), 1000)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(redeemSharesAmount))
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
        
        let tokenBalances1 = await getTokenBalances(user1.address, false, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.add(actualAssetsAmount))
        expect(tokenBalances1.ausdceBalance).eq(tokenBalances0.ausdceBalance)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.sub(redeemSharesAmount))

        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(vaultStats1.ausdceBalance)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expectInRange(tokenBalances1.maxRedeemAsATokens, vaultStats1.ausdceBalance.mul(vaultStats1.totalSupply).div(vaultStats1.totalAssets), 10)
      })
      it("can redeem using underlying and atokens", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")
        let redeemSharesAmount = tokenBalances0.wausdceBalance
        let expectedAssetsAmount = vaultStats0.convertToAssets.mul(redeemSharesAmount).div(WeiPerUsdc.mul(1000))
        let expectedAssetsAmount2 = await wausdce.previewRedeem(redeemSharesAmount)
        expect(expectedAssetsAmount).gt(vaultStats0.usdceBalance)
        let expectedAssetsAmount3 = await wausdce.previewRedeemAsATokens(redeemSharesAmount)
        expect(expectedAssetsAmount3).lt(expectedAssetsAmount2)
        
        let tx = await wausdce.connect(user1).redeem(redeemSharesAmount, user1.address, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let withdrawEvents = events?.filter(x => x.event == "Withdraw")
        expect(withdrawEvents).to.not.be.null
        expect(withdrawEvents.length).eq(1)
        let withdrawEvent = withdrawEvents[0]

        let actualAssetsAmount = withdrawEvent.args.assets
        expectInRange(actualAssetsAmount, expectedAssetsAmount, 2000)
        expectInRange(actualAssetsAmount, expectedAssetsAmount2, 2000)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(wausdce.address, user1.address, actualAssetsAmount) // withdraw comes from wausdce
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, redeemSharesAmount)
        await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user1.address, user1.address, user1.address, actualAssetsAmount, redeemSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats1.usdceBalance).eq(0)
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.sub(actualAssetsAmount).add(vaultStats0.usdceBalance), 1000)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(actualAssetsAmount), 1000)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(redeemSharesAmount))
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
        
        let tokenBalances1 = await getTokenBalances(user1.address, false, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.add(actualAssetsAmount))
        expect(tokenBalances1.ausdceBalance).eq(tokenBalances0.ausdceBalance)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.sub(redeemSharesAmount))
        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
      })
    })
    describe("withdrawATokens", function () {
      it("deposit past supply cap", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        let extraAmount = WeiPerUsdc.mul(1000)
        let depositAssetsAmount = vaultStats0.maxAssetsSuppliableToSake.add(extraAmount)
        let tx = await wausdce.connect(user1).deposit(depositAssetsAmount, user1.address)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats0.maxAssetsSuppliableToSake).gt(0)
        expect(vaultStats1.maxAssetsSuppliableToSake).eq(0)
      })
      it("cannot withdrawATokens over supply cap", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")
        let withdrawAssetsAmount = tokenBalances0.wausdceBalance.mul(vaultStats0.totalAssets).div(vaultStats0.totalSupply)
        await expect(wausdce.connect(user1).withdrawATokens(withdrawAssetsAmount, user1.address, user1.address)).to.be.revertedWith("51")
      })
    })
    describe("redeemAsATokens", function () {
      it("cannot redeemAsATokens over supply cap", async function () {
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")
        let redeemSharesAmount = tokenBalances0.wausdceBalance
        await expect(wausdce.connect(user1).redeemAsATokens(redeemSharesAmount, user1.address, user1.address)).to.be.revertedWith("51")
      })
    })
  })

  context("when supply cap is infinite", function () {
    describe("with finite supply cap", async function () {
      it("withdraw some underlying", async function () {
        let vaultStats0 = await getVaultStats(wausdce, false)
        await wausdce.connect(user1).withdraw(vaultStats0.usdceBalance.add(WeiPerUsdc.mul(1000)), user1.address, user1.address)
      })
      it("max suppliable is limited by supply cap", async function () {
        let maxAssetsSuppliableToSake = await wausdce.maxAssetsSuppliableToSake()
        expect(maxAssetsSuppliableToSake).gt(0)
        expect(maxAssetsSuppliableToSake).lt(MaxUint256)
      })
    })
    describe("setup", function () {
      it("can set supply cap to infinite", async function () {
        let tx = await poolConfigurator.connect(timelockImpersonated).setSupplyCap(USDCE_ADDRESS, 0) // 0 means infinite
      })
    })
    describe("with infinite supply cap", async function () {
      it("max suppliable is unlimited", async function () {
        let maxAssetsSuppliableToSake = await wausdce.maxAssetsSuppliableToSake()
        expect(maxAssetsSuppliableToSake).eq(MaxUint256)
      })
    })
    describe("deposit", function () {
      it("deposit a lot", async function () {
        let depositAssetsAmount = WeiPerUsdc.mul(100_000_000)
        await setUsdceBalance(user1.address, depositAssetsAmount)

        let vaultStats0 = await getVaultStats(wausdce, false)
        let tokenBalances0 = await getTokenBalances(user1.address, false, "user1")
        let expectedSharesAmount = depositAssetsAmount.mul(vaultStats0.totalSupply).div(vaultStats0.totalAssets)
        let expectedSharesAmount2 = await wausdce.previewDeposit(depositAssetsAmount)

        let tx = await wausdce.connect(user1).deposit(depositAssetsAmount, user1.address)

        let receipt = await tx.wait()
        let events = receipt.events
        let depositEvents = events?.filter(x => x.event == "Deposit")
        expect(depositEvents).to.not.be.null
        expect(depositEvents.length).eq(1)
        let depositEvent = depositEvents[0]
        
        let actualSharesAmount = depositEvent.args.shares
        expectInRange(actualSharesAmount, expectedSharesAmount, 20000)
        expectInRange(actualSharesAmount, expectedSharesAmount2, 20000)
        await expect(tx).to.emit(usdce, "Transfer").withArgs(user1.address, wausdce.address, depositAssetsAmount)
        await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user1.address, actualSharesAmount)
        await expect(tx).to.emit(wausdce, "Deposit").withArgs(user1.address, user1.address, depositAssetsAmount, actualSharesAmount)

        let vaultStats1 = await getVaultStats(wausdce, false)
        expect(vaultStats1.usdceBalance).eq(0)
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(depositAssetsAmount).add(vaultStats0.usdceBalance), 1000)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(actualSharesAmount))
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(depositAssetsAmount), 1000)
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)

        let tokenBalances1 = await getTokenBalances(user1.address, false, "user1")
        expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.sub(depositAssetsAmount))
        expect(tokenBalances1.ausdceBalance).eq(0)
        expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.add(actualSharesAmount))
        expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
        expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
        expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
        expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
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
