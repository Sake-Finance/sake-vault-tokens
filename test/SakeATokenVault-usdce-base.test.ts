/* global describe it before ethers */

import hre from "hardhat";
const { ethers } = hre;
const { provider } = ethers;
import { BigNumber as BN, BigNumberish } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
const { expect, assert } = chai;
import fs from "fs";

import { MockERC20, SakeATokenVault, SakeProxyAdmin, SakeATokenVaultFactory, IPool, Multicall3 } from "./../typechain-types";

import { isDeployed, expectDeployed } from "./../scripts/utils/expectDeployed";
import { toBytes32, manipulateERC20BalanceOf } from "./../scripts/utils/setStorage";
import { getNetworkSettings } from "../scripts/utils/getNetworkSettings";
import { decimalsToAmount } from "../scripts/utils/price";
import { leftPad, rightPad } from "../scripts/utils/strings";
import { deployContract } from "../scripts/utils/deployContract";
import L1DataFeeAnalyzer from "../scripts/utils/L1DataFeeAnalyzer";
import { getSelectors, FacetCutAction, calcSighash, calcSighashes, getCombinedAbi } from "./../scripts/utils/diamond"
import { expectInRange } from "../scripts/utils/test";

const { AddressZero, WeiPerEther, MaxUint256, Zero } = ethers.constants;
const { formatUnits } = ethers.utils;

const Bytes32Zero = toBytes32(0);
const WeiPerUsdc = BN.from(1_000_000); // 6 decimals
const SecondsPerDay = 86400;
const SecondsPerHour = 3600;

describe("SakeATokenVault-usdce-base", function () {
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

  let multicall3: Multicall3;
  let vault: SakeATokenVault;
  let vaultImplementation: SakeATokenVault;
  let usdce: MockERC20;
  let ausdce: MockERC20;
  let wausdce: SakeATokenVault;
  let wausdce2: SakeATokenVault; // different address from above
  let pool: IPool;
  let otherToken: MockERC20;

  let proxyAdmin: SakeProxyAdmin;
  let vaultFactory: SakeATokenVaultFactory;

  const MULTICALL3_ADDRESS = "0xB981161Be7D05d7a291Ffa5CE32c2771422De385";
  const USDCE_ADDRESS = "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369"
  const AUSDCE_ADDRESS = "0x4491B60c8fdD668FcC2C4dcADf9012b3fA71a726"
  const POOL_ADDRESS = "0x3C3987A310ee13F7B8cBBe21D97D4436ba5E4B5f"
  const AAVE_POOL_ADDRESSES_PROVIDER_ADDRESS = "0x73a35ca19Da0357651296c40805c31585f19F741"

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

    multicall3 = await ethers.getContractAt("Multicall3", MULTICALL3_ADDRESS) as Multicall3;
    usdce = await ethers.getContractAt("MockERC20", USDCE_ADDRESS) as MockERC20;
    ausdce = await ethers.getContractAt("MockERC20", AUSDCE_ADDRESS) as MockERC20;
    pool = await ethers.getContractAt("IPool", POOL_ADDRESS) as IPool;

    otherToken = await deployContract(deployer, "MockERC20", ["OtherToken", "OTHER", 18]) as MockERC20;
  });

  after(async function () {
    await provider.send("evm_revert", [snapshot]);
  });

  describe("deploy SakeATokenVault implementation", function () {
    it("cannot deploy SakeATokenVault with address zero", async function () {
      await expect(deployContract(deployer, "SakeATokenVault", [AddressZero, AUSDCE_ADDRESS, POOL_ADDRESS, referralCode])).to.be.reverted//WithCustomError(vaultImplementation, "AddressZero");
      await expect(deployContract(deployer, "SakeATokenVault", [USDCE_ADDRESS, AddressZero, POOL_ADDRESS, referralCode])).to.be.reverted//WithCustomError(vaultImplementation, "AddressZero");
      await expect(deployContract(deployer, "SakeATokenVault", [USDCE_ADDRESS, AUSDCE_ADDRESS, AddressZero, referralCode])).to.be.reverted//WithCustomError(vaultImplementation, "AddressZero");
    })
    it("cannot deploy SakeATokenVault with token not a reserve", async function () {
      //await expect(deployContract(deployer, "SakeATokenVault", [user1.address, referralCode, AAVE_POOL_ADDRESSES_PROVIDER_ADDRESS])).to.be.revertedWith("ASSET_NOT_SUPPORTED");
      await expect(deployContract(deployer, "SakeATokenVault", [otherToken.address, AUSDCE_ADDRESS, POOL_ADDRESS, referralCode])).to.be.reverted//WithCustomError(vaultImplementation, "AssetNotInPool");
    })
    it("cannot deploy SakeATokenVault with asset invalid", async function () {
      await expect(deployContract(deployer, "SakeATokenVault", [USDCE_ADDRESS, otherToken.address, POOL_ADDRESS, referralCode])).to.be.reverted//WithCustomError(vaultImplementation, "AssetNotInPool");
    })
    it("can deploy SakeATokenVault implementation", async function () {
      //vaultImplementation = await deployContract(deployer, "SakeATokenVault", [USDCE_ADDRESS, referralCode, AAVE_POOL_ADDRESSES_PROVIDER_ADDRESS]) as SakeATokenVault;
      vaultImplementation = await deployContract(deployer, "SakeATokenVault", [USDCE_ADDRESS, AUSDCE_ADDRESS, POOL_ADDRESS, referralCode]) as SakeATokenVault;
      await expectDeployed(vaultImplementation.address);
      l1DataFeeAnalyzer.register("deploy SakeATokenVault implementation", vaultImplementation.deployTransaction);
    })
    it("some values are set on the implementation", async function () {
      expect(await vaultImplementation.underlying()).eq(USDCE_ADDRESS)
      expect(await vaultImplementation.aToken()).eq(AUSDCE_ADDRESS)
      expect(await vaultImplementation.pool()).eq(POOL_ADDRESS)
      expect(await vaultImplementation.referralCode()).eq(0)
    })
    it("some values are not set on the implementation", async function () {
      expect(await vaultImplementation.asset()).eq(AddressZero)//.eq(USDCE_ADDRESS)
      expect(await vaultImplementation.name()).eq("")
      expect(await vaultImplementation.symbol()).eq("")
      expect(await vaultImplementation.decimals()).eq(0)
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
    it("cannot deploy with zero initial deposit", async function () {
      await expect(vaultFactory.connect(owner).createVault(
        vaultImplementation.address,
        proxyAdmin.address,
        owner.address,
        toBytes32(0),
        "ERC4626-Wrapped Sake aUSDC.e",
        "waUSDC.e",
        false,
        0
      )).to.be.revertedWithCustomError(vaultFactory, "AmountZero")
    })
    it("cannot deploy with address zero owner", async function () {
      await expect(vaultFactory.connect(owner).createVault(
        vaultImplementation.address,
        proxyAdmin.address,
        AddressZero,
        toBytes32(0),
        "ERC4626-Wrapped Sake aUSDC.e",
        "waUSDC.e",
        false,
        1
      )).to.be.reverted//WithCustomError(proxy, "AddressZero")
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
      await expect(tx).to.emit(usdce, "Transfer").withArgs(owner.address, vaultFactory.address, WeiPerUsdc.mul(100))
      await expect(tx).to.emit(usdce, "Transfer").withArgs(vaultFactory.address, proxyAddress, WeiPerUsdc.mul(100))
    })
    it("starts set correctly", async function () {
      expect(await wausdce.name()).eq("ERC4626-Wrapped Sake aUSDC.e")
      expect(await wausdce.symbol()).eq("waUSDC.e")
      expect(await wausdce.decimals()).eq(6)
      expect(await wausdce.owner()).eq(owner.address)

      expect(await wausdce.asset()).eq(USDCE_ADDRESS)
      expect(await wausdce.underlying()).eq(USDCE_ADDRESS)
      expect(await wausdce.aToken()).eq(AUSDCE_ADDRESS)
      expect(await wausdce.pool()).eq(POOL_ADDRESS)
      expect(await wausdce.referralCode()).eq(0)
    })
    it("starts with supply", async function () {
      let vaultStats = await getVaultStats(wausdce)
      expect(vaultStats.totalSupply).eq(WeiPerUsdc.mul(100))
      expect(vaultStats.usdceBalance).eq(0)
      expect(vaultStats.ausdceBalance).eq(WeiPerUsdc.mul(100))
      expect(vaultStats.wausdceBalance).eq(0)
      expect(vaultStats.totalAssets).eq(vaultStats.usdceBalance.add(vaultStats.ausdceBalance))
      expect(vaultStats.convertToAssets).eq(WeiPerUsdc.mul(1000))
      expect(vaultStats.convertToShares).eq(WeiPerUsdc.mul(1000))
    })
    it("creator starts with balance", async function () {
      let tokenBalances = await getTokenBalances(owner.address, true, "creator")
      expect(tokenBalances.usdceBalance).eq(WeiPerUsdc.mul(9_900))
      expect(tokenBalances.ausdceBalance).eq(0)
      expect(tokenBalances.wausdceBalance).eq(WeiPerUsdc.mul(100))
      expect(tokenBalances.maxRedeem).eq(tokenBalances.wausdceBalance)
      expect(tokenBalances.maxRedeemAsATokens).eq(tokenBalances.wausdceBalance)
    })
  })

  describe("initialize", function () {
    it("cannot initialize implementation", async function () {
      await expect(vaultImplementation.connect(owner).initialize(owner.address, "asdf", "asdf")).to.be.revertedWithCustomError(vaultImplementation, "InvalidInitialization")
    })
    it("cannot reinitialize proxy", async function () {
      await expect(wausdce.connect(owner).initialize(owner.address, "asdf", "asdf")).to.be.revertedWithCustomError(wausdce, "InvalidInitialization")
    })
  })

  describe("interest", function () {
    it("earns interest over time", async function () {
      let vaultStatsLast = await getVaultStats(wausdce)
      for(let i = 0; i < 3; i++) {
        // advance time
        await provider.send("evm_increaseTime", [SecondsPerHour]);
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

  describe("deposit() 1", function () {
    it("max deposit is max uint", async function () {
      expect(await wausdce.maxDeposit(user1.address)).eq(MaxUint256)
    })
    it("preview deposit zero is zero", async function () {
      expect(await wausdce.previewDeposit(0)).eq(0)
    })
    it("cannot deposit with insufficient allowance", async function () {
      await expect(wausdce.connect(user1).deposit(WeiPerUsdc.mul(100), user1.address)).to.be.revertedWith("ERC20: transfer amount exceeds allowance")
    })
    it("cannot deposit with insufficient balance", async function () {
      await usdce.connect(user1).approve(wausdce.address, MaxUint256)
      await expect(wausdce.connect(user1).deposit(WeiPerUsdc.mul(100), user1.address)).to.be.revertedWith("ERC20: transfer amount exceeds balance")
    })
    it("cannot deposit for zero shares", async function () {
      await expect(wausdce.connect(user1).deposit(0, user1.address)).to.be.revertedWithCustomError(wausdce, "ZeroShares")
    })
    it("can deposit", async function () {
      let mintAmount = WeiPerUsdc.mul(100)
      let depositAssetsAmount = WeiPerUsdc.mul(10)
      await setUsdceBalance(user1.address, mintAmount)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
      let expectedSharesAmount = vaultStats0.convertToShares.mul(10).div(1000)
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
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(depositAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(actualSharesAmount))
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(depositAssetsAmount), 10)
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)

      let tokenBalances1 = await getTokenBalances(user1.address, true, "user1")
      expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.sub(depositAssetsAmount))
      expect(tokenBalances1.ausdceBalance).eq(0)
      expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.add(actualSharesAmount))
      expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
      expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
      expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
    })
    it("can deposit to other user", async function () {
      let depositAssetsAmount = WeiPerUsdc.mul(20)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances01 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances05 = await getTokenBalances(user5.address, true, "user5")
      let expectedSharesAmount = vaultStats0.convertToShares.mul(20).div(1000)
      let expectedSharesAmount2 = await wausdce.previewDeposit(depositAssetsAmount)

      let tx = await wausdce.connect(user1).deposit(depositAssetsAmount, user5.address)

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
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user5.address, actualSharesAmount)
      await expect(tx).to.emit(wausdce, "Deposit").withArgs(user1.address, user5.address, depositAssetsAmount, actualSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(depositAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(actualSharesAmount))
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(depositAssetsAmount), 10)
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)

      let tokenBalances11 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances15 = await getTokenBalances(user5.address, true, "user5")
      expect(tokenBalances11.usdceBalance).eq(tokenBalances01.usdceBalance.sub(depositAssetsAmount))
      expect(tokenBalances11.ausdceBalance).eq(0)
      expect(tokenBalances11.wausdceBalance).eq(tokenBalances01.wausdceBalance)
      expect(tokenBalances15.usdceBalance).eq(0)
      expect(tokenBalances15.ausdceBalance).eq(0)
      expect(tokenBalances15.wausdceBalance).eq(tokenBalances05.wausdceBalance.add(actualSharesAmount))
      expectInRange(tokenBalances15.maxWithdraw, tokenBalances15.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances15.maxWithdrawAsATokens).eq(tokenBalances15.maxWithdraw)
      expect(tokenBalances15.maxRedeem).eq(tokenBalances15.wausdceBalance)
      expect(tokenBalances15.maxRedeemAsATokens).eq(tokenBalances15.wausdceBalance)
    })
  })

  describe("depositATokens() 1", function () {
    it("cannot depositATokens with insufficient allowance", async function () {
      await expect(wausdce.connect(user2).depositATokens(WeiPerUsdc.mul(100), user2.address)).to.be.reverted//With("ERC20: transfer amount exceeds allowance")
    })
    it("cannot depositATokens with insufficient balance", async function () {
      await ausdce.connect(user2).approve(wausdce.address, MaxUint256)
      await expect(wausdce.connect(user2).depositATokens(WeiPerUsdc.mul(100), user2.address)).to.be.reverted
    })
    it("cannot depositATokens for zero shares", async function () {
      await expect(wausdce.connect(user2).depositATokens(0, user2.address)).to.be.revertedWithCustomError(wausdce, "ZeroShares")
    })
    it("can depositATokens", async function () {
      let mintAmount = WeiPerUsdc.mul(100)
      let depositAssetsAmount = WeiPerUsdc.mul(10)
      await setUsdceBalance(user2.address, mintAmount)
      await usdce.connect(user2).approve(POOL_ADDRESS, MaxUint256)
      await pool.connect(user2).supply(USDCE_ADDRESS, mintAmount, user2.address, 0)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances0 = await getTokenBalances(user2.address, true, "user2")
      let expectedSharesAmount = vaultStats0.convertToShares.mul(10).div(1000)
      let expectedSharesAmount2 = await wausdce.previewDeposit(depositAssetsAmount)

      let tx = await wausdce.connect(user2).depositATokens(depositAssetsAmount, user2.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let depositEvents = events?.filter(x => x.event == "Deposit")
      expect(depositEvents).to.not.be.null
      expect(depositEvents.length).eq(1)
      let depositEvent = depositEvents[0]
      
      let actualSharesAmount = depositEvent.args.shares
      expectInRange(actualSharesAmount, expectedSharesAmount, 10)
      expectInRange(actualSharesAmount, expectedSharesAmount2, 10)
      await expect(tx).to.emit(ausdce, "Transfer").withArgs(user2.address, wausdce.address, depositAssetsAmount)
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user2.address, actualSharesAmount)
      await expect(tx).to.emit(wausdce, "Deposit").withArgs(user2.address, user2.address, depositAssetsAmount, actualSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(depositAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(depositAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(actualSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
      
      let tokenBalances1 = await getTokenBalances(user2.address, true, "user2")
      expect(tokenBalances1.usdceBalance).eq(0)
      expectInRange(tokenBalances1.ausdceBalance, mintAmount.sub(depositAssetsAmount), 10)
      expect(tokenBalances1.wausdceBalance).eq(tokenBalances0.wausdceBalance.add(actualSharesAmount))
      expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
      expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
      expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
    })
    it("can depositATokens to other user", async function () {
      //let mintAmount = WeiPerUsdc.mul(100)
      let depositAssetsAmount = WeiPerUsdc.mul(20)
      //await setUsdceBalance(user2.address, mintAmount)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances02 = await getTokenBalances(user2.address, true, "user2")
      let tokenBalances05 = await getTokenBalances(user5.address, true, "user5")
      let expectedSharesAmount = vaultStats0.convertToShares.mul(20).div(1000)
      let expectedSharesAmount2 = await wausdce.previewDeposit(depositAssetsAmount)

      let tx = await wausdce.connect(user2).depositATokens(depositAssetsAmount, user5.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let depositEvents = events?.filter(x => x.event == "Deposit")
      expect(depositEvents).to.not.be.null
      expect(depositEvents.length).eq(1)
      let depositEvent = depositEvents[0]
      
      let actualSharesAmount = depositEvent.args.shares
      expectInRange(actualSharesAmount, expectedSharesAmount, 10)
      expectInRange(actualSharesAmount, expectedSharesAmount2, 10)
      await expect(tx).to.emit(ausdce, "Transfer").withArgs(user2.address, wausdce.address, depositAssetsAmount)
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user5.address, actualSharesAmount)
      await expect(tx).to.emit(wausdce, "Deposit").withArgs(user2.address, user5.address, depositAssetsAmount, actualSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(depositAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(actualSharesAmount))
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(depositAssetsAmount), 10)
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)
      
      let tokenBalances12 = await getTokenBalances(user2.address, true, "user2")
      let tokenBalances15 = await getTokenBalances(user5.address, true, "user5")
      expect(tokenBalances12.usdceBalance).eq(tokenBalances02.usdceBalance)
      //expect(tokenBalances12.ausdceBalance).eq(0)
      expectInRange(tokenBalances12.ausdceBalance, tokenBalances02.ausdceBalance.sub(depositAssetsAmount), 10)
      expect(tokenBalances12.wausdceBalance).eq(tokenBalances02.wausdceBalance)
      expect(tokenBalances15.usdceBalance).eq(0)
      expect(tokenBalances15.ausdceBalance).eq(0)
      expect(tokenBalances15.wausdceBalance).eq(tokenBalances05.wausdceBalance.add(actualSharesAmount))
      expectInRange(tokenBalances15.maxWithdraw, tokenBalances15.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances15.maxWithdrawAsATokens).eq(tokenBalances15.maxWithdraw)
      expect(tokenBalances15.maxRedeem).eq(tokenBalances15.wausdceBalance)
      expect(tokenBalances15.maxRedeemAsATokens).eq(tokenBalances15.wausdceBalance)
    })
  })

  describe("mint() 1", function () {
    it("preview mint zero is zero", async function () {
      expect(await wausdce.previewMint(0)).eq(0)
    })
    it("max mint is max uint", async function () {
      expect(await wausdce.maxMint(user1.address)).eq(MaxUint256)
    })
    it("cannot mint with insufficient allowance", async function () {
      await expect(wausdce.connect(user3).mint(WeiPerUsdc.mul(100), user3.address)).to.be.revertedWith("ERC20: transfer amount exceeds allowance")
    })
    it("cannot mint with insufficient balance", async function () {
      await usdce.connect(user3).approve(wausdce.address, MaxUint256)
      await expect(wausdce.connect(user3).mint(WeiPerUsdc.mul(100), user3.address)).to.be.revertedWith("ERC20: transfer amount exceeds balance")
    })
    it("can mint", async function () {

      let mintAmount = WeiPerUsdc.mul(100)
      let mintSharesAmount = WeiPerUsdc.mul(10)
      await setUsdceBalance(user3.address, mintAmount)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances0 = await getTokenBalances(user3.address, true, "user3")
      let expectedAssetsAmount = vaultStats0.convertToAssets.mul(10).div(1000)
      let expectedAssetsAmount2 = await wausdce.previewMint(mintSharesAmount)

      let tx = await wausdce.connect(user3).mint(mintSharesAmount, user3.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let depositEvents = events?.filter(x => x.event == "Deposit")
      expect(depositEvents).to.not.be.null
      expect(depositEvents.length).eq(1)
      let depositEvent = depositEvents[0]
      
      let actualAssetsAmount = depositEvent.args.assets
      expectInRange(actualAssetsAmount, expectedAssetsAmount, 10)
      expectInRange(actualAssetsAmount, expectedAssetsAmount2, 10)
      await expect(tx).to.emit(usdce, "Transfer").withArgs(user3.address, wausdce.address, actualAssetsAmount)
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user3.address, mintSharesAmount)
      await expect(tx).to.emit(wausdce, "Deposit").withArgs(user3.address, user3.address, actualAssetsAmount, mintSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(actualAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(actualAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(mintSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
      
      let tokenBalances1 = await getTokenBalances(user3.address, true, "user3")
      expect(tokenBalances1.usdceBalance).eq(mintAmount.sub(actualAssetsAmount))
      expect(tokenBalances1.ausdceBalance).eq(0)
      expect(tokenBalances1.wausdceBalance).eq(mintSharesAmount)
      expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
      expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
      expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
    })
    it("can mint to other user", async function () {
      let mintSharesAmount = WeiPerUsdc.mul(20)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances03 = await getTokenBalances(user3.address, true, "user3")
      let tokenBalances05 = await getTokenBalances(user5.address, true, "user5")
      let expectedAssetsAmount = vaultStats0.convertToAssets.mul(20).div(1000)
      let expectedAssetsAmount2 = await wausdce.previewMint(mintSharesAmount)

      let tx = await wausdce.connect(user3).mint(mintSharesAmount, user5.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let depositEvents = events?.filter(x => x.event == "Deposit")
      expect(depositEvents).to.not.be.null
      expect(depositEvents.length).eq(1)
      let depositEvent = depositEvents[0]
      
      let actualAssetsAmount = depositEvent.args.assets
      expectInRange(actualAssetsAmount, expectedAssetsAmount, 10)
      expectInRange(actualAssetsAmount, expectedAssetsAmount2, 10)
      await expect(tx).to.emit(usdce, "Transfer").withArgs(user3.address, wausdce.address, actualAssetsAmount)
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user5.address, mintSharesAmount)
      await expect(tx).to.emit(wausdce, "Deposit").withArgs(user3.address, user5.address, actualAssetsAmount, mintSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(actualAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(actualAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(mintSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
      
      let tokenBalances13 = await getTokenBalances(user3.address, true, "user3")
      let tokenBalances15 = await getTokenBalances(user5.address, true, "user5")
      expect(tokenBalances13.usdceBalance).eq(tokenBalances03.usdceBalance.sub(actualAssetsAmount))
      expect(tokenBalances13.ausdceBalance).eq(0)
      expect(tokenBalances13.wausdceBalance).eq(tokenBalances03.wausdceBalance)
      expect(tokenBalances15.usdceBalance).eq(0)
      expect(tokenBalances15.ausdceBalance).eq(0)
      expect(tokenBalances15.wausdceBalance).eq(tokenBalances05.wausdceBalance.add(mintSharesAmount))
      expectInRange(tokenBalances15.maxWithdraw, tokenBalances15.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances15.maxWithdrawAsATokens).eq(tokenBalances15.maxWithdraw)
      expect(tokenBalances15.maxRedeem).eq(tokenBalances15.wausdceBalance)
      expect(tokenBalances15.maxRedeemAsATokens).eq(tokenBalances15.wausdceBalance)
    })
  })

  describe("mintWithATokens() 1", function () {
    it("cannot mintWithATokens with insufficient allowance", async function () {
      await expect(wausdce.connect(user2).mintWithATokens(WeiPerUsdc.mul(100), user2.address)).to.be.reverted//With("ERC20: transfer amount exceeds allowance")
    })
    it("cannot mintWithATokens with insufficient balance", async function () {
      await ausdce.connect(user4).approve(wausdce.address, MaxUint256)
      await expect(wausdce.connect(user4).mintWithATokens(WeiPerUsdc.mul(100), user4.address)).to.be.reverted
    })
    it("can mintWithATokens", async function () {

      let mintAmount = WeiPerUsdc.mul(100)
      let mintSharesAmount = WeiPerUsdc.mul(10)
      await setUsdceBalance(user4.address, mintAmount)
      await usdce.connect(user4).approve(POOL_ADDRESS, MaxUint256)
      await pool.connect(user4).supply(USDCE_ADDRESS, mintAmount, user4.address, 0)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances0 = await getTokenBalances(user4.address, true, "user4")
      let expectedAssetsAmount = vaultStats0.convertToAssets.mul(10).div(1000)
      let expectedAssetsAmount2 = await wausdce.previewMint(mintSharesAmount)

      let tx = await wausdce.connect(user4).mintWithATokens(mintSharesAmount, user4.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let depositEvents = events?.filter(x => x.event == "Deposit")
      expect(depositEvents).to.not.be.null
      expect(depositEvents.length).eq(1)
      let depositEvent = depositEvents[0]
      
      let actualAssetsAmount = depositEvent.args.assets
      expectInRange(actualAssetsAmount, expectedAssetsAmount, 10)
      expectInRange(actualAssetsAmount, expectedAssetsAmount2, 10)
      await expect(tx).to.emit(ausdce, "Transfer").withArgs(user4.address, wausdce.address, actualAssetsAmount)
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user4.address, mintSharesAmount)
      await expect(tx).to.emit(wausdce, "Deposit").withArgs(user4.address, user4.address, actualAssetsAmount, mintSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(actualAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(actualAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(mintSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
      
      let tokenBalances1 = await getTokenBalances(user4.address, true, "user4")
      expect(tokenBalances1.usdceBalance).eq(0)
      expectInRange(tokenBalances1.ausdceBalance, mintAmount.sub(actualAssetsAmount), 10)
      expect(tokenBalances1.wausdceBalance).eq(mintSharesAmount)
      expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
      expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
      expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
    })
    it("can mintWithATokens to other user", async function () {
      let mintSharesAmount = WeiPerUsdc.mul(20)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances04 = await getTokenBalances(user4.address, true, "user4")
      let tokenBalances05 = await getTokenBalances(user5.address, true, "user5")
      let expectedAssetsAmount = vaultStats0.convertToAssets.mul(20).div(1000)
      let expectedAssetsAmount2 = await wausdce.previewMint(mintSharesAmount)

      let tx = await wausdce.connect(user4).mintWithATokens(mintSharesAmount, user5.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let depositEvents = events?.filter(x => x.event == "Deposit")
      expect(depositEvents).to.not.be.null
      expect(depositEvents.length).eq(1)
      let depositEvent = depositEvents[0]
      
      let actualAssetsAmount = depositEvent.args.assets
      expectInRange(actualAssetsAmount, expectedAssetsAmount, 10)
      expectInRange(actualAssetsAmount, expectedAssetsAmount2, 10)
      await expect(tx).to.emit(ausdce, "Transfer").withArgs(user4.address, wausdce.address, actualAssetsAmount)
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(AddressZero, user5.address, mintSharesAmount)
      await expect(tx).to.emit(wausdce, "Deposit").withArgs(user4.address, user5.address, actualAssetsAmount, mintSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.add(actualAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.add(actualAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.add(mintSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
      
      let tokenBalances14 = await getTokenBalances(user4.address, true, "user4")
      let tokenBalances15 = await getTokenBalances(user5.address, true, "user5")
      expect(tokenBalances14.usdceBalance).eq(0)
      expectInRange(tokenBalances14.ausdceBalance, tokenBalances04.ausdceBalance.sub(actualAssetsAmount), 10)
      expect(tokenBalances14.wausdceBalance).eq(tokenBalances04.wausdceBalance)
      expect(tokenBalances15.usdceBalance).eq(0)
      expect(tokenBalances15.ausdceBalance).eq(0)
      expect(tokenBalances15.wausdceBalance).eq(tokenBalances05.wausdceBalance.add(mintSharesAmount))
      expectInRange(tokenBalances15.maxWithdraw, tokenBalances15.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances15.maxWithdrawAsATokens).eq(tokenBalances15.maxWithdraw)
      expect(tokenBalances15.maxRedeem).eq(tokenBalances15.wausdceBalance)
      expect(tokenBalances15.maxRedeemAsATokens).eq(tokenBalances15.wausdceBalance)
    })
  })

  describe("withdraw", function () {
    it("preview withdraw zero is zero", async function () {
      expect(await wausdce.previewWithdraw(0)).eq(0)
    })
    it("maxWithdraw with zero balance is zero", async function () {
      expect(await wausdce.maxWithdraw(user6.address)).eq(0)
    })
    it("cannot withdraw with insufficient balance", async function () {
      await expect(wausdce.connect(user1).withdraw(WeiPerUsdc.mul(100), user1.address, user1.address)).to.be.revertedWithCustomError(wausdce, "ERC20InsufficientBalance")
    })
    it("can withdraw", async function () {
      let withdrawAssetsAmount = WeiPerUsdc.mul(5)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
      let expectedSharesAmount = vaultStats0.convertToShares.mul(5).div(1000)
      let expectedSharesAmount2 = await wausdce.previewWithdraw(withdrawAssetsAmount)
      let expectedSharesAmount3 = await wausdce.previewWithdrawAsATokens(withdrawAssetsAmount)
      expect(expectedSharesAmount3).eq(expectedSharesAmount2)

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
      await expect(tx).to.emit(usdce, "Transfer").withArgs(AUSDCE_ADDRESS, user1.address, withdrawAssetsAmount) // withdraw directly from sake
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
      expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.add(withdrawAssetsAmount))
      expect(tokenBalances1.ausdceBalance).eq(tokenBalances0.ausdceBalance)
      expectInRange(tokenBalances1.wausdceBalance, tokenBalances0.wausdceBalance.sub(expectedSharesAmount))
      expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
      expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
      expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
    })
    it("cannot withdraw from other user with insufficient allowance", async function () {
      await wausdce.connect(user1).approve(user6.address, 0)
      await expect(wausdce.connect(user6).withdraw(WeiPerUsdc.mul(1), user7.address, user1.address)).to.be.revertedWithCustomError(wausdce, "ERC20InsufficientAllowance")
    })
    it("can withdraw from and to another user", async function () {
      let approvalAmount = WeiPerUsdc.mul(100)
      await wausdce.connect(user1).approve(user6.address, approvalAmount)
      let withdrawAssetsAmount = WeiPerUsdc.mul(1)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances01 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances06 = await getTokenBalances(user6.address, true, "user6")
      let tokenBalances07 = await getTokenBalances(user7.address, true, "user7")
      let expectedSharesAmount = vaultStats0.convertToShares.mul(1).div(1000)
      let expectedSharesAmount2 = await wausdce.previewWithdraw(withdrawAssetsAmount)
      let expectedSharesAmount3 = await wausdce.previewWithdrawAsATokens(withdrawAssetsAmount)
      expect(expectedSharesAmount3).eq(expectedSharesAmount2)

      let tx = await wausdce.connect(user6).withdraw(WeiPerUsdc.mul(1), user7.address, user1.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let withdrawEvents = events?.filter(x => x.event == "Withdraw")
      expect(withdrawEvents).to.not.be.null
      expect(withdrawEvents.length).eq(1)
      let withdrawEvent = withdrawEvents[0]

      let actualSharesAmount = withdrawEvent.args.shares
      expectInRange(actualSharesAmount, expectedSharesAmount, 10)
      expectInRange(actualSharesAmount, expectedSharesAmount2, 10)
      await expect(tx).to.emit(usdce, "Transfer").withArgs(AUSDCE_ADDRESS, user7.address, withdrawAssetsAmount) // withdraw directly from sake
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, actualSharesAmount)
      await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user6.address, user7.address, user1.address, withdrawAssetsAmount, actualSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.sub(withdrawAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(withdrawAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(actualSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)

      let tokenBalances11 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances16 = await getTokenBalances(user6.address, true, "user6")
      let tokenBalances17 = await getTokenBalances(user7.address, true, "user7")

      expect(tokenBalances11.usdceBalance).eq(tokenBalances01.usdceBalance)
      expect(tokenBalances11.ausdceBalance).eq(tokenBalances01.ausdceBalance)
      expectInRange(tokenBalances11.wausdceBalance, tokenBalances01.wausdceBalance.sub(expectedSharesAmount))
      expectInRange(tokenBalances11.maxWithdraw, tokenBalances11.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances11.maxWithdrawAsATokens).eq(tokenBalances11.maxWithdraw)
      expect(tokenBalances11.maxRedeem).eq(tokenBalances11.wausdceBalance)
      expect(tokenBalances11.maxRedeemAsATokens).eq(tokenBalances11.wausdceBalance)

      expect(tokenBalances16.usdceBalance).eq(0)
      expect(tokenBalances16.ausdceBalance).eq(0)
      expect(tokenBalances16.wausdceBalance).eq(0)

      expect(tokenBalances17.usdceBalance).eq(tokenBalances07.usdceBalance.add(withdrawAssetsAmount))
      expect(tokenBalances17.ausdceBalance).eq(0)
      expect(tokenBalances17.wausdceBalance).eq(0)

      expect(await wausdce.allowance(user1.address, user6.address)).eq(approvalAmount.sub(actualSharesAmount))
    })
  })

  describe("withdrawATokens", function () {
    it("preview withdraw zero is zero", async function () {
      expect(await wausdce.previewWithdrawAsATokens(0)).eq(0)
    })
    it("deposit more", async function () {
      await setUsdceBalance(user1.address, WeiPerUsdc.mul(80))
      await wausdce.connect(user1).deposit(WeiPerUsdc.mul(80), user1.address)
    })
    it("maxWithdrawAsATokens with zero balance is zero", async function () {
      expect(await wausdce.maxWithdrawAsATokens(user6.address)).eq(0)
    })
    it("cannot withdrawATokens with insufficient balance", async function () {
      await expect(wausdce.connect(user1).withdrawATokens(WeiPerUsdc.mul(100), user1.address, user1.address)).to.be.revertedWithCustomError(wausdce, "ERC20InsufficientBalance")
    })
    it("can withdrawATokens", async function () {
      let withdrawAssetsAmount = WeiPerUsdc.mul(5)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
      let expectedSharesAmount = vaultStats0.convertToShares.mul(5).div(1000)
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
      expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
      expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
      expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
    })
    it("cannot withdrawATokens from other user with insufficient allowance", async function () {
      await wausdce.connect(user1).approve(user6.address, 0)
      await expect(wausdce.connect(user6).withdrawATokens(WeiPerUsdc.mul(1), user7.address, user1.address)).to.be.revertedWithCustomError(wausdce, "ERC20InsufficientAllowance")
    })
    it("can withdrawATokens from and to another user", async function () {
      let approvalAmount = WeiPerUsdc.mul(100)
      await wausdce.connect(user1).approve(user6.address, approvalAmount)
      let withdrawAssetsAmount = WeiPerUsdc.mul(1)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances01 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances06 = await getTokenBalances(user6.address, true, "user6")
      let tokenBalances07 = await getTokenBalances(user7.address, true, "user7")
      let expectedSharesAmount = vaultStats0.convertToShares.mul(1).div(1000)
      let expectedSharesAmount2 = await wausdce.previewWithdraw(withdrawAssetsAmount)
      let expectedSharesAmount3 = await wausdce.previewWithdrawAsATokens(withdrawAssetsAmount)
      expect(expectedSharesAmount3).eq(expectedSharesAmount2)

      let tx = await wausdce.connect(user6).withdrawATokens(WeiPerUsdc.mul(1), user7.address, user1.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let withdrawEvents = events?.filter(x => x.event == "Withdraw")
      expect(withdrawEvents).to.not.be.null
      expect(withdrawEvents.length).eq(1)
      let withdrawEvent = withdrawEvents[0]

      let actualSharesAmount = withdrawEvent.args.shares
      expectInRange(actualSharesAmount, expectedSharesAmount, 10)
      expectInRange(actualSharesAmount, expectedSharesAmount2, 10)
      await expect(tx).to.emit(ausdce, "Transfer").withArgs(wausdce.address, user7.address, withdrawAssetsAmount)
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, actualSharesAmount)
      await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user6.address, user7.address, user1.address, withdrawAssetsAmount, actualSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.sub(withdrawAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(withdrawAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(actualSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)

      let tokenBalances11 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances16 = await getTokenBalances(user6.address, true, "user6")
      let tokenBalances17 = await getTokenBalances(user7.address, true, "user7")

      expect(tokenBalances11.usdceBalance).eq(tokenBalances01.usdceBalance)
      expectInRange(tokenBalances11.ausdceBalance, tokenBalances01.ausdceBalance, 10)
      expectInRange(tokenBalances11.wausdceBalance, tokenBalances01.wausdceBalance.sub(expectedSharesAmount))
      expectInRange(tokenBalances11.maxWithdraw, tokenBalances11.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances11.maxWithdrawAsATokens).eq(tokenBalances11.maxWithdraw)
      expect(tokenBalances11.maxRedeem).eq(tokenBalances11.wausdceBalance)
      expect(tokenBalances11.maxRedeemAsATokens).eq(tokenBalances11.wausdceBalance)

      expect(tokenBalances16.usdceBalance).eq(0)
      expect(tokenBalances16.ausdceBalance).eq(0)
      expect(tokenBalances16.wausdceBalance).eq(0)

      expect(tokenBalances17.usdceBalance).eq(tokenBalances07.usdceBalance)
      expectInRange(tokenBalances17.ausdceBalance, tokenBalances07.ausdceBalance.add(withdrawAssetsAmount))
      expect(tokenBalances17.wausdceBalance).eq(0)

      expect(await wausdce.allowance(user1.address, user6.address)).eq(approvalAmount.sub(actualSharesAmount))
    })
  })

  describe("redeem", function () {
    it("preview redeem zero is zero", async function () {
      expect(await wausdce.previewRedeem(0)).eq(0)
    })
    it("cannot redeem with insufficient balance", async function () {
      //await wausdce.connect(user1).redeem(WeiPerUsdc.mul(100), user1.address, user1.address)
      //await expect(wausdce.connect(user1).redeem(WeiPerUsdc.mul(100), user1.address, user1.address)).to.be.revertedWith("REDEEM_EXCEEDS_MAX")//CustomError(wausdce, "WithdrawExceedsMax")
      await expect(wausdce.connect(user1).redeem(WeiPerUsdc.mul(100), user1.address, user1.address)).to.be.revertedWithCustomError(wausdce, "ERC20InsufficientBalance")
    })
    it("can redeem", async function () {
      let redeemSharesAmount = WeiPerUsdc.mul(5)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
      let expectedAssetsAmount = vaultStats0.convertToAssets.mul(5).div(1000)
      let expectedAssetsAmount2 = await wausdce.previewRedeem(redeemSharesAmount)
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
      await expect(tx).to.emit(usdce, "Transfer").withArgs(AUSDCE_ADDRESS, user1.address, actualAssetsAmount) // withdraw directly from sake
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, redeemSharesAmount)
      await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user1.address, user1.address, user1.address, actualAssetsAmount, redeemSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.sub(actualAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(actualAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(redeemSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
      
      let tokenBalances1 = await getTokenBalances(user1.address, true, "user1")
      expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance.add(actualAssetsAmount))
      expect(tokenBalances1.ausdceBalance).eq(tokenBalances0.ausdceBalance)
      expectInRange(tokenBalances1.wausdceBalance, tokenBalances0.wausdceBalance.sub(redeemSharesAmount))
      expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
      expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
      expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
    })
    it("cannot redeem from other user with insufficient allowance", async function () {
      await wausdce.connect(user1).approve(user6.address, 0)
      await expect(wausdce.connect(user6).redeem(WeiPerUsdc.mul(1), user7.address, user1.address)).to.be.revertedWithCustomError(wausdce, "ERC20InsufficientAllowance")
    })
    it("can redeem from and to another user", async function () {
      let approvalAmount = WeiPerUsdc.mul(100)
      await wausdce.connect(user1).approve(user6.address, approvalAmount)
      let redeemSharesAmount = WeiPerUsdc.mul(1)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances01 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances06 = await getTokenBalances(user6.address, true, "user6")
      let tokenBalances07 = await getTokenBalances(user7.address, true, "user7")
      let expectedAssetsAmount = vaultStats0.convertToAssets.mul(1).div(1000)
      let expectedAssetsAmount2 = await wausdce.previewRedeem(redeemSharesAmount)
      let expectedAssetsAmount3 = await wausdce.previewRedeemAsATokens(redeemSharesAmount)
      expect(expectedAssetsAmount3).eq(expectedAssetsAmount2)

      let tx = await wausdce.connect(user6).redeem(WeiPerUsdc.mul(1), user7.address, user1.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let withdrawEvents = events?.filter(x => x.event == "Withdraw")
      expect(withdrawEvents).to.not.be.null
      expect(withdrawEvents.length).eq(1)
      let withdrawEvent = withdrawEvents[0]

      let actualAssetsAmount = withdrawEvent.args.assets
      expectInRange(actualAssetsAmount, expectedAssetsAmount, 10)
      expectInRange(actualAssetsAmount, expectedAssetsAmount2, 10)
      await expect(tx).to.emit(usdce, "Transfer").withArgs(AUSDCE_ADDRESS, user7.address, actualAssetsAmount) // withdraw directly from sake
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, redeemSharesAmount)
      await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user6.address, user7.address, user1.address, actualAssetsAmount, redeemSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.sub(actualAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(actualAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(redeemSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)

      let tokenBalances11 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances16 = await getTokenBalances(user6.address, true, "user6")
      let tokenBalances17 = await getTokenBalances(user7.address, true, "user7")

      expect(tokenBalances11.usdceBalance).eq(tokenBalances01.usdceBalance)
      expect(tokenBalances11.ausdceBalance).eq(tokenBalances01.ausdceBalance)
      expectInRange(tokenBalances11.wausdceBalance, tokenBalances01.wausdceBalance.sub(redeemSharesAmount))
      expectInRange(tokenBalances11.maxWithdraw, tokenBalances11.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances11.maxWithdrawAsATokens).eq(tokenBalances11.maxWithdraw)
      expect(tokenBalances11.maxRedeem).eq(tokenBalances11.wausdceBalance)
      expect(tokenBalances11.maxRedeemAsATokens).eq(tokenBalances11.wausdceBalance)

      expect(tokenBalances16.usdceBalance).eq(0)
      expect(tokenBalances16.ausdceBalance).eq(0)
      expect(tokenBalances16.wausdceBalance).eq(0)

      expect(tokenBalances17.usdceBalance).eq(tokenBalances07.usdceBalance.add(actualAssetsAmount))
      expect(tokenBalances17.ausdceBalance, tokenBalances07.ausdceBalance, 10)
      expect(tokenBalances17.wausdceBalance).eq(0)

      expect(await wausdce.allowance(user1.address, user6.address)).eq(approvalAmount.sub(redeemSharesAmount))
    })
    /*
    it("cannot redeem for zero assets", async function () {
      // requires balance manipulation, cannot happen in production
      await wausdce.connect(user1).redeem(1, user1.address, user1.address)
      //await expect(wausdce.connect(user1).redeem(1, user1.address, user1.address)).to.be.revertedWith()
    })
    */
  })

  describe("redeemAsATokens", function () {
    it("preview redeem zero is zero", async function () {
      expect(await wausdce.previewRedeemAsATokens(0)).eq(0)
    })
    it("cannot redeemAsATokens with insufficient balance", async function () {
      //await wausdce.connect(user1).redeemAsATokens(WeiPerUsdc.mul(100), user1.address, user1.address)
      //await expect(wausdce.connect(user1).redeemAsATokens(WeiPerUsdc.mul(100), user1.address, user1.address)).to.be.revertedWith("REDEEM_EXCEEDS_MAX")//CustomError(wausdce, "WithdrawExceedsMax")
      await expect(wausdce.connect(user1).redeemAsATokens(WeiPerUsdc.mul(100), user1.address, user1.address)).to.be.revertedWithCustomError(wausdce, "ERC20InsufficientBalance")
    })
    it("can redeemAsATokens", async function () {
      let redeemSharesAmount = WeiPerUsdc.mul(5)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances0 = await getTokenBalances(user1.address, true, "user1")
      let expectedAssetsAmount = vaultStats0.convertToAssets.mul(5).div(1000)
      let expectedAssetsAmount2 = await wausdce.previewRedeem(redeemSharesAmount)
      let expectedAssetsAmount3 = await wausdce.previewRedeemAsATokens(redeemSharesAmount)
      expect(expectedAssetsAmount3).eq(expectedAssetsAmount2)

      let tx = await wausdce.connect(user1).redeemAsATokens(redeemSharesAmount, user1.address, user1.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let withdrawEvents = events?.filter(x => x.event == "Withdraw")
      expect(withdrawEvents).to.not.be.null
      expect(withdrawEvents.length).eq(1)
      let withdrawEvent = withdrawEvents[0]

      let actualAssetsAmount = withdrawEvent.args.assets
      expectInRange(actualAssetsAmount, expectedAssetsAmount, 10)
      expectInRange(actualAssetsAmount, expectedAssetsAmount2, 10)
      await expect(tx).to.emit(ausdce, "Transfer").withArgs(wausdce.address, user1.address, actualAssetsAmount)
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, redeemSharesAmount)
      await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user1.address, user1.address, user1.address, actualAssetsAmount, redeemSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.sub(actualAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(actualAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(redeemSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)
      
      let tokenBalances1 = await getTokenBalances(user1.address, true, "user1")
      expect(tokenBalances1.usdceBalance).eq(tokenBalances0.usdceBalance)
      expectInRange(tokenBalances1.ausdceBalance, tokenBalances0.ausdceBalance.add(actualAssetsAmount), 10)
      expectInRange(tokenBalances1.wausdceBalance, tokenBalances0.wausdceBalance.sub(redeemSharesAmount))
      expectInRange(tokenBalances1.maxWithdraw, tokenBalances1.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances1.maxWithdrawAsATokens).eq(tokenBalances1.maxWithdraw)
      expect(tokenBalances1.maxRedeem).eq(tokenBalances1.wausdceBalance)
      expect(tokenBalances1.maxRedeemAsATokens).eq(tokenBalances1.wausdceBalance)
    })
    it("cannot redeemAsATokens from other user with insufficient allowance", async function () {
      await wausdce.connect(user1).approve(user6.address, 0)
      await expect(wausdce.connect(user6).redeemAsATokens(WeiPerUsdc.mul(1), user7.address, user1.address)).to.be.revertedWithCustomError(wausdce, "ERC20InsufficientAllowance")
    })
    it("can redeemAsATokens from and to another user", async function () {
      let approvalAmount = WeiPerUsdc.mul(100)
      await wausdce.connect(user1).approve(user6.address, approvalAmount)
      let redeemSharesAmount = WeiPerUsdc.mul(1)

      let vaultStats0 = await getVaultStats(wausdce)
      let tokenBalances01 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances06 = await getTokenBalances(user6.address, true, "user6")
      let tokenBalances07 = await getTokenBalances(user7.address, true, "user7")
      let expectedAssetsAmount = vaultStats0.convertToAssets.mul(1).div(1000)
      let expectedAssetsAmount2 = await wausdce.previewRedeem(redeemSharesAmount)
      let expectedAssetsAmount3 = await wausdce.previewRedeemAsATokens(redeemSharesAmount)
      expect(expectedAssetsAmount3).eq(expectedAssetsAmount2)

      let tx = await wausdce.connect(user6).redeemAsATokens(WeiPerUsdc.mul(1), user7.address, user1.address)

      let receipt = await tx.wait()
      let events = receipt.events
      let withdrawEvents = events?.filter(x => x.event == "Withdraw")
      expect(withdrawEvents).to.not.be.null
      expect(withdrawEvents.length).eq(1)
      let withdrawEvent = withdrawEvents[0]

      let actualAssetsAmount = withdrawEvent.args.assets
      expectInRange(actualAssetsAmount, expectedAssetsAmount, 10)
      expectInRange(actualAssetsAmount, expectedAssetsAmount2, 10)
      await expect(tx).to.emit(ausdce, "Transfer").withArgs(wausdce.address, user7.address, actualAssetsAmount)
      await expect(tx).to.emit(wausdce, "Transfer").withArgs(user1.address, AddressZero, redeemSharesAmount)
      await expect(tx).to.emit(wausdce, "Withdraw").withArgs(user6.address, user7.address, user1.address, actualAssetsAmount, redeemSharesAmount)

      let vaultStats1 = await getVaultStats(wausdce)
      expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
      expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance.sub(actualAssetsAmount), 10)
      expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
      expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets.sub(actualAssetsAmount), 10)
      expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply.sub(redeemSharesAmount))
      expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 20)
      expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 20)

      let tokenBalances11 = await getTokenBalances(user1.address, true, "user1")
      let tokenBalances16 = await getTokenBalances(user6.address, true, "user6")
      let tokenBalances17 = await getTokenBalances(user7.address, true, "user7")

      expect(tokenBalances11.usdceBalance).eq(tokenBalances01.usdceBalance)
      expectInRange(tokenBalances11.ausdceBalance, tokenBalances01.ausdceBalance, 10)
      expectInRange(tokenBalances11.wausdceBalance, tokenBalances01.wausdceBalance.sub(redeemSharesAmount))
      expectInRange(tokenBalances11.maxWithdraw, tokenBalances11.wausdceBalance.mul(vaultStats1.totalAssets).div(vaultStats1.totalSupply), 10)
      expect(tokenBalances11.maxWithdrawAsATokens).eq(tokenBalances11.maxWithdraw)
      expect(tokenBalances11.maxRedeem).eq(tokenBalances11.wausdceBalance)
      expect(tokenBalances11.maxRedeemAsATokens).eq(tokenBalances11.wausdceBalance)

      expect(tokenBalances16.usdceBalance).eq(0)
      expect(tokenBalances16.ausdceBalance).eq(0)
      expect(tokenBalances16.wausdceBalance).eq(0)

      expect(tokenBalances17.usdceBalance).eq(tokenBalances07.usdceBalance)
      expectInRange(tokenBalances17.ausdceBalance, tokenBalances07.ausdceBalance.add(actualAssetsAmount), 10)
      expect(tokenBalances17.wausdceBalance).eq(0)

      expect(await wausdce.allowance(user1.address, user6.address)).eq(approvalAmount.sub(redeemSharesAmount))
    })
    /*
    it("cannot redeemAsATokens for zero assets", async function () {
      // requires balance manipulation, cannot happen in production
      await wausdce.connect(user1).redeemAsATokens(1, user1.address, user1.address)
    })
    */
  })

  describe("ownable", function () {
    it("starts with the correct owner", async function () {
      expect(await wausdce.owner()).eq(owner.address)
      expect(await wausdce.pendingOwner()).eq(AddressZero);
    })
    it("non owner cannot transfer ownership", async function () {
      //await wausdce.connect(user1).transferOwnership(user1.address)
      await expect(wausdce.connect(user1).transferOwnership(user1.address)).to.be.revertedWithCustomError(wausdce, "OwnableUnauthorizedAccount");
    });
    it("owner can start ownership transfer", async function () {
      let tx = await wausdce.connect(owner).transferOwnership(user2.address);
      expect(await wausdce.owner()).eq(owner.address);
      expect(await wausdce.pendingOwner()).eq(user2.address);
      await expect(tx).to.emit(wausdce, "OwnershipTransferStarted").withArgs(owner.address, user2.address);
    });
    it("non pending owner cannot accept ownership", async function () {
      //await wausdce.connect(user1).acceptOwnership()
      await expect(wausdce.connect(user1).acceptOwnership()).to.be.revertedWithCustomError(wausdce, "OwnableUnauthorizedAccount");
    });
    it("new owner can accept ownership", async function () {
      let tx = await wausdce.connect(user2).acceptOwnership();
      expect(await wausdce.owner()).eq(user2.address);
      expect(await wausdce.pendingOwner()).eq(AddressZero);
      await expect(tx).to.emit(wausdce, "OwnershipTransferred").withArgs(owner.address, user2.address);
    });
    it("old owner does not have ownership rights", async function () {
      //await wausdce.connect(owner).rescueTokens(otherToken.address, user1.address, 0)
      await expect(wausdce.connect(owner).rescueTokens(otherToken.address, user1.address, 0)).to.be.revertedWithCustomError(wausdce, "OwnableUnauthorizedAccount")
      await expect(wausdce.connect(owner).claimRewards(user1.address)).to.be.revertedWithCustomError(wausdce, "OwnableUnauthorizedAccount")
    });
    it("new owner has ownership rights - rescueTokens", async function () {
      await otherToken.mint(wausdce.address, WeiPerEther.mul(100))
      let tx = await wausdce.connect(user2).rescueTokens(otherToken.address, user1.address, WeiPerEther.mul(10))
      expect(await otherToken.balanceOf(user1.address)).eq(WeiPerEther.mul(10))
      expect(await otherToken.balanceOf(wausdce.address)).eq(WeiPerEther.mul(90))
      await expect(tx).to.emit(wausdce, "TokensRescued").withArgs(otherToken.address, user1.address, WeiPerEther.mul(10));
    });
    it("cannot rescue underlying", async function () {
      await expect(wausdce.connect(user2).rescueTokens(USDCE_ADDRESS, user1.address, 0)).to.be.revertedWithCustomError(wausdce, "CannotRescueUnderlying")//("CANNOT_RESCUE_UNDERLYING")
    });
    it("cannot rescue aToken", async function () {
      await expect(wausdce.connect(user2).rescueTokens(AUSDCE_ADDRESS, user1.address, 0)).to.be.revertedWithCustomError(wausdce, "CannotRescueAToken")//("CANNOT_RESCUE_ATOKEN")
    });
    it("new owner has ownership rights - claimRewards", async function () {
      let tx = await wausdce.connect(user2).claimRewards(user3.address)
      //expect(await otherToken.balanceOf(user1.address)).eq(WeiPerEther.mul(10))
      //expect(await otherToken.balanceOf(wausdce.address)).eq(WeiPerEther.mul(90))
      let rewardsList = [] as any[] // no rewards
      let claimedAmounts = [] as any[]
      await expect(tx).to.emit(wausdce, "RewardsClaimed").withArgs(user3.address, rewardsList, claimedAmounts);
      //let receipt = await tx.wait()
      //let events = receipt.events
      //console.log(`events`)
      //console.log(events)
    });
    it("cannot claim rewards to address zero", async function () {
      await expect(wausdce.connect(user2).claimRewards(AddressZero)).to.be.revertedWithCustomError(wausdce, "AddressZero");
    })
    it("non owner cannot renounce ownership", async function () {
      //await wausdce.connect(user1).renounceOwnership()
      await expect(wausdce.connect(user1).renounceOwnership()).to.be.revertedWithCustomError(wausdce, "OwnableUnauthorizedAccount");
    });
    it("owner can renounce ownership", async function () {
      let tx = await wausdce.connect(user2).renounceOwnership();
      expect(await wausdce.owner()).eq(AddressZero);
      expect(await wausdce.pendingOwner()).eq(AddressZero);
      await expect(tx).to.emit(wausdce, "OwnershipTransferred").withArgs(user2.address, AddressZero);
    });
  })

  describe("deploy SakeATokenVault proxy with initial deposit aTokens", function () {
    let proxyAddress: string
    it("mint ausdce", async function () {
      await setUsdceBalance(owner.address, WeiPerUsdc.mul(10000));
      await usdce.connect(owner).approve(POOL_ADDRESS, MaxUint256)
      await pool.connect(owner).supply(USDCE_ADDRESS, WeiPerUsdc.mul(10000), owner.address, 0)
      await ausdce.connect(owner).approve(vaultFactory.address, MaxUint256)
    })
    it("cannot deploy with zero initial deposit", async function () {
      await expect(vaultFactory.connect(owner).createVault(
        vaultImplementation.address,
        proxyAdmin.address,
        owner.address,
        toBytes32(1),
        "ERC4626-Wrapped Sake aUSDC.e",
        "waUSDC.e",
        true,
        0
      )).to.be.revertedWithCustomError(vaultFactory, "AmountZero")
    })
    it("cannot deploy with address zero owner", async function () {
      await expect(vaultFactory.connect(owner).createVault(
        vaultImplementation.address,
        proxyAdmin.address,
        AddressZero,
        toBytes32(1),
        "ERC4626-Wrapped Sake aUSDC.e",
        "waUSDC.e",
        true,
        1
      )).to.be.reverted//WithCustomError(proxy, "AddressZero")
    })
    it("can precalculate proxy address", async function () {
      proxyAddress = await vaultFactory.connect(owner).callStatic.createVault(
        vaultImplementation.address,
        proxyAdmin.address,
        owner.address,
        toBytes32(1),
        "ERC4626-Wrapped Sake aUSDC.e",
        "waUSDC.e",
        true,
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
        toBytes32(1),
        "ERC4626-Wrapped Sake aUSDC.e",
        "waUSDC.e",
        true,
        WeiPerUsdc.mul(100)
      )
      expect(await isDeployed(proxyAddress)).to.be.true
      await expect(tx).to.emit(vaultFactory, "VaultCreated").withArgs(proxyAddress)
      wausdce2 = await ethers.getContractAt("SakeATokenVault", proxyAddress) as SakeATokenVault
      await expect(tx).to.emit(ausdce, "Transfer").withArgs(owner.address, vaultFactory.address, WeiPerUsdc.mul(100))
      await expect(tx).to.emit(ausdce, "Transfer").withArgs(vaultFactory.address, proxyAddress, WeiPerUsdc.mul(100))
    })
    it("starts set correctly", async function () {
      expect(await wausdce2.name()).eq("ERC4626-Wrapped Sake aUSDC.e")
      expect(await wausdce2.symbol()).eq("waUSDC.e")
      expect(await wausdce2.decimals()).eq(6)
      expect(await wausdce2.owner()).eq(owner.address)

      expect(await wausdce2.asset()).eq(USDCE_ADDRESS)
      expect(await wausdce2.underlying()).eq(USDCE_ADDRESS)
      expect(await wausdce2.aToken()).eq(AUSDCE_ADDRESS)
      expect(await wausdce2.pool()).eq(POOL_ADDRESS)
      expect(await wausdce2.referralCode()).eq(0)
    })
    it("starts with supply", async function () {
      let vaultStats = await getVaultStats(wausdce2)
      expect(vaultStats.totalSupply).eq(WeiPerUsdc.mul(100))
      expect(vaultStats.usdceBalance).eq(0)
      expect(vaultStats.ausdceBalance).eq(WeiPerUsdc.mul(100))
      expect(vaultStats.wausdceBalance).eq(0)
      expect(vaultStats.totalAssets).eq(vaultStats.usdceBalance.add(vaultStats.ausdceBalance))
      expect(vaultStats.convertToAssets).eq(WeiPerUsdc.mul(1000))
      expect(vaultStats.convertToShares).eq(WeiPerUsdc.mul(1000))
    })
    it("creator starts with balance", async function () {
      expect(await wausdce2.balanceOf(owner.address)).eq(WeiPerUsdc.mul(100))
    })
  })

  /*
  describe("withdrawATokens 2", function () {
    it("can withdrawATokens and convert some underlying to atoken", async function () {
    })
  })
  */

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
