/* global describe it before ethers */

import hre from "hardhat";
const { ethers } = hre;
const { provider } = ethers;
import { BigNumber as BN, BigNumberish } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
const { expect, assert } = chai;
import fs from "fs";

import { MockERC20, SakeATokenVault, SakeProxyAdmin, SakeATokenVaultFactory, IPool, Multicall3, IWETH, MockSakeATokenVault, ITransparentUpgradeableProxy, SakeTransparentUpgradeableProxy } from "./../typechain-types";

import { isDeployed, expectDeployed } from "./../scripts/utils/expectDeployed";
import { toBytes32, manipulateERC20BalanceOf, findERC20BalanceOfSlot } from "./../scripts/utils/setStorage";
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

const PROXY_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

describe("SakeATokenVault-usdce-upgrades", function () {
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
  let vaultImplementation2: MockSakeATokenVault; // different address from above, different implementation
  let usdce: MockERC20;
  let ausdce: MockERC20;
  let wausdce: SakeATokenVault;
  let wausdce2: MockSakeATokenVault; // same address as above, different implementation
  let wausdce3: MockSakeATokenVault; // different address from above
  let pool: IPool;
  let otherToken: MockERC20;
  let weth: IWETH;
  let usdt: MockERC20;

  let proxyAdmin: SakeProxyAdmin;
  let proxyAdmin2: MockSakeProxyAdmin; // different from above
  let vaultFactory: SakeATokenVaultFactory;

  const MULTICALL3_ADDRESS = "0xB981161Be7D05d7a291Ffa5CE32c2771422De385";
  const USDCE_ADDRESS = "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369"
  const AUSDCE_ADDRESS = "0x4491B60c8fdD668FcC2C4dcADf9012b3fA71a726"
  const POOL_ADDRESS = "0x3C3987A310ee13F7B8cBBe21D97D4436ba5E4B5f"
  const AAVE_POOL_ADDRESSES_PROVIDER_ADDRESS = "0x73a35ca19Da0357651296c40805c31585f19F741"
  const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"
  const USDT_ADDRESS = "0x3A337a6adA9d885b6Ad95ec48F9b75f197b5AE35"

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
    await expectDeployed(WETH_ADDRESS)
    await expectDeployed(USDT_ADDRESS)

    multicall3 = await ethers.getContractAt("Multicall3", MULTICALL3_ADDRESS) as Multicall3;
    usdce = await ethers.getContractAt("MockERC20", USDCE_ADDRESS) as MockERC20;
    ausdce = await ethers.getContractAt("MockERC20", AUSDCE_ADDRESS) as MockERC20;
    pool = await ethers.getContractAt("IPool", POOL_ADDRESS) as IPool;
    weth = await ethers.getContractAt("IWETH", WETH_ADDRESS) as IWETH;
    usdt = await ethers.getContractAt("MockERC20", USDT_ADDRESS) as MockERC20;

    otherToken = await deployContract(deployer, "MockERC20", ["OtherToken", "OTHER", 18]) as MockERC20;
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
    it("proxy has correct owner", async function () {
      expect(await wausdce.owner()).eq(owner.address)
    })
    it("proxy has correct implementation", async function () {
      let value = await provider.getStorageAt(wausdce.address, PROXY_IMPLEMENTATION_SLOT);
      //console.log(`impl`);
      //console.log(value);
      let impl = bytes32ToAddress(value)
      //console.log(impl);
      expect(impl).eq(vaultImplementation.address)
    })
    it("proxy has correct admin", async function () {
      let value = await provider.getStorageAt(wausdce.address, PROXY_ADMIN_SLOT);
      //console.log(`admin`);
      //console.log(value);
      let admin = bytes32ToAddress(value)
      //console.log(admin);
      expect(admin).eq(proxyAdmin.address)
    })
    it("proxy admin has correct owner", async function () {
      expect(await proxyAdmin.owner()).eq(owner.address)
    })
    it("proxy admin has correct upgrade interface version", async function () {
      expect(await proxyAdmin.UPGRADE_INTERFACE_VERSION()).eq("5.0.0")
    })
  })

  context("upgraded proxy implementation", function () {
    let vaultStats0:any;
    let vaultStats1:any;
    let tokenBalances01:any;
    let tokenBalances02:any;
    let tokenBalances03:any;
    let tokenBalances11:any;
    let tokenBalances12:any;
    let tokenBalances13:any;

    describe("setup", function () {
      it("accumulate interest", async function () {
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
      it("make some deposits", async function () {
        await setUsdceBalance(user1.address, WeiPerUsdc.mul(10_000_000));
        await usdce.connect(user1).approve(wausdce.address, MaxUint256)
        await wausdce.connect(user1).deposit(WeiPerUsdc.mul(1_000), user1.address)

        await setUsdceBalance(user2.address, WeiPerUsdc.mul(10_000_000));
        await usdce.connect(user2).approve(wausdce.address, MaxUint256)
        await wausdce.connect(user2).deposit(WeiPerUsdc.mul(2_000), user2.address)

        await setUsdceBalance(user2.address, WeiPerUsdc.mul(10_000_000));
        await usdce.connect(user2).approve(wausdce.address, MaxUint256)
        await wausdce.connect(user2).deposit(WeiPerUsdc.mul(3_000), user2.address)

        tokenBalances01 = await getTokenBalances(user1.address, true, "user1")
        tokenBalances02 = await getTokenBalances(user2.address, true, "user2")
        tokenBalances03 = await getTokenBalances(user3.address, true, "user3")
      })
      it("make some approvals", async function () {
        await wausdce.connect(user1).approve(user2.address, 5)
        await wausdce.connect(user2).approve(user3.address, 6)
        await wausdce.connect(user3).approve(user4.address, 7)
      })
    })
    describe("deploy new implementation", function () {
      it("can deploy MockSakeATokenVault implementation", async function () {
        vaultImplementation2 = await deployContract(deployer, "MockSakeATokenVault", [USDCE_ADDRESS, AUSDCE_ADDRESS, POOL_ADDRESS, referralCode2]) as MockSakeATokenVault;
        await expectDeployed(vaultImplementation2.address);
        l1DataFeeAnalyzer.register("deploy MockSakeATokenVault implementation", vaultImplementation2.deployTransaction);
        expect(await vaultImplementation2.referralCode()).eq(referralCode2)
      })
    })
    describe("upgrade", function () {
      let vaultProxy: ITransparentUpgradeableProxy;
      it("get proxy interface", async function () {
        vaultProxy = await ethers.getContractAt("contracts/interfaces/proxy/ITransparentUpgradeableProxy.sol:ITransparentUpgradeableProxy", wausdce.address) as ITransparentUpgradeableProxy;
      })
      it("non proxy admin owner cannot upgrade", async function () {
        await expect(proxyAdmin.connect(user1).upgradeAndCall(wausdce.address, vaultImplementation2.address, "0x")).to.be.revertedWithCustomError(proxyAdmin, "NotContractOwner");
      })
      //it("non proxy admin cannot upgrade", async function () {})
      it("can upgrade", async function () {
        // pre record vault stats
        vaultStats0 = await getVaultStats(wausdce)

        let tx = await proxyAdmin.connect(owner).upgradeAndCall(wausdce.address, vaultImplementation2.address, "0x")
        await expect(tx).to.emit(vaultProxy, "Upgraded").withArgs(vaultImplementation2.address)
      })
    })
    describe("after upgrade", function () {
      it("proxy has correct implementation", async function () {
        let value = await provider.getStorageAt(wausdce.address, PROXY_IMPLEMENTATION_SLOT);
        //console.log(`impl`);
        //console.log(value);
        let impl = bytes32ToAddress(value)
        //console.log(impl);
        expect(impl).eq(vaultImplementation2.address)
      })
      it("proxy has correct admin", async function () {
        let value = await provider.getStorageAt(wausdce.address, PROXY_ADMIN_SLOT);
        //console.log(`admin`);
        //console.log(value);
        let admin = bytes32ToAddress(value)
        //console.log(admin);
        expect(admin).eq(proxyAdmin.address)
      })
      it("user balances have not changed", async function () {
        tokenBalances11 = await getTokenBalances(user1.address, true, "user1")
        tokenBalances12 = await getTokenBalances(user2.address, true, "user2")
        tokenBalances13 = await getTokenBalances(user3.address, true, "user3")

        expect(tokenBalances11.wausdceBalance).eq(tokenBalances01.wausdceBalance)
        expect(tokenBalances12.wausdceBalance).eq(tokenBalances02.wausdceBalance)
        expect(tokenBalances13.wausdceBalance).eq(tokenBalances03.wausdceBalance)
      })
      it("user allowances have not changed", async function () {
        expect(await wausdce.allowance(user1.address, user2.address)).eq(5)
        expect(await wausdce.allowance(user2.address, user3.address)).eq(6)
        expect(await wausdce.allowance(user3.address, user4.address)).eq(7)
        expect(await wausdce.allowance(user4.address, user5.address)).eq(0)
      })
      it("vault stats have not changed except interest", async function () {
        vaultStats1 = await getVaultStats(wausdce)
        expect(vaultStats1.usdceBalance).eq(vaultStats0.usdceBalance)
        expectInRange(vaultStats1.ausdceBalance, vaultStats0.ausdceBalance, 10)
        expect(vaultStats1.wausdceBalance).eq(vaultStats0.wausdceBalance)
        expect(vaultStats1.totalSupply).eq(vaultStats0.totalSupply)
        expectInRange(vaultStats1.totalAssets, vaultStats0.totalAssets, 10)
        expectInRange(vaultStats1.convertToAssets, vaultStats0.convertToAssets, 10)
        expectInRange(vaultStats1.convertToShares, vaultStats0.convertToShares, 10)
      })
      it("can get new wausdce interface", async function () {
        wausdce2 = await ethers.getContractAt("MockSakeATokenVault", wausdce.address) as MockSakeATokenVault;
      })
      it("can use new functions", async function () {
        let tx = await wausdce2.connect(user1).addedFunction()
        await expect(tx).to.emit(wausdce2, "AddedEvent")
      })
      it("picked up new immutables", async function () {
        expect(await wausdce2.referralCode()).eq(referralCode2)
        expect(await wausdce.referralCode()).eq(referralCode2) // same proxy address
      })
      /*
      it("can use existing functions - deposit", async function () {
        
      })
      it("can use existing functions - mint", async function () {
        
      })
      it("can use existing functions - withdraw", async function () {
        
      })
      it("can use existing functions - redeem", async function () {
        
      })
      */
    })
  })

  context("new vault new proxy admin", function () {
    let proxyAddress: string
    describe("setup", function () {
      it("can deploy MockSakeProxyAdmin", async function () {
        proxyAdmin2 = await deployContract(deployer, "MockSakeProxyAdmin", [owner.address]) as MockSakeProxyAdmin;
        await expectDeployed(proxyAdmin2.address);
        l1DataFeeAnalyzer.register("deploy MockSakeProxyAdmin", proxyAdmin2.deployTransaction);
        expect(await proxyAdmin2.owner()).eq(owner.address)
      })
      it("can precalculate proxy address", async function () {
        proxyAddress = await vaultFactory.connect(owner).callStatic.createVault(
          vaultImplementation2.address,
          proxyAdmin2.address,
          owner.address,
          toBytes32(1),
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
          vaultImplementation2.address,
          proxyAdmin2.address,
          owner.address,
          toBytes32(1),
          "ERC4626-Wrapped Sake aUSDC.e",
          "waUSDC.e",
          false,
          WeiPerUsdc.mul(100)
        )
        expect(await isDeployed(proxyAddress)).to.be.true
        await expect(tx).to.emit(vaultFactory, "VaultCreated").withArgs(proxyAddress)
        wausdce3 = await ethers.getContractAt("MockSakeATokenVault", proxyAddress) as MockSakeATokenVault
      })
    })
    describe("upgrade", function () {
      it("proxy admin cannot call a function besides upgradeToAndCall", async function () {
        let data = "0x12345678"
        let vaultProxy2 = await ethers.getContractAt("SakeTransparentUpgradeableProxy", wausdce3.address) as SakeTransparentUpgradeableProxy;
        await expect(proxyAdmin2.connect(owner).forwardData(wausdce3.address, data)).to.be.revertedWithCustomError(vaultProxy2, "ProxyDeniedAdminAccess");
      })
    })
  })

  async function setUsdceBalance(address:string, amount:BigNumberish) {
    //let balanceOfSlot = await findERC20BalanceOfSlot(USDCE_ADDRESS)
    //console.log(`usdce balanceOf slot: ${balanceOfSlot}`)
    let balanceOfSlot = 9
    await manipulateERC20BalanceOf(USDCE_ADDRESS, balanceOfSlot, address, amount)
  }

  async function setUsdtBalance(address:string, amount:BigNumberish) {
    //let balanceOfSlot = await findERC20BalanceOfSlot(USDT_ADDRESS)
    //console.log(`usdt balanceOf slot: ${balanceOfSlot}`)
    let balanceOfSlot = 0
    await manipulateERC20BalanceOf(USDT_ADDRESS, balanceOfSlot, address, amount)
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

// only works in this case
function bytes32ToAddress(s:string) {
  //if(s.length < 66 || s.substring(0,26) != "0x000000000000000000000000") throw new Error(`Invalid bytes32 '${s}'`)
  if(s.length < 66 || s.substring(0,26) != "0x000000000000000000000000") return ""
  return ethers.utils.getAddress('0x' + s.substring(26, 66))
}