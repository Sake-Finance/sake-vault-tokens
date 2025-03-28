/* global describe it before ethers */

import hre from "hardhat";
const { ethers } = hre;
const { provider } = ethers;
import { BigNumber as BN, BigNumberish } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai from "chai";
const { expect, assert } = chai;
import fs from "fs";

import { MockERC20, ContractFactory } from "./../typechain-types";

import { isDeployed, expectDeployed } from "./../scripts/utils/expectDeployed";
import { toBytes32 } from "./../scripts/utils/setStorage";
import { getNetworkSettings } from "../scripts/utils/getNetworkSettings";
import { decimalsToAmount } from "../scripts/utils/price";
import { leftPad } from "../scripts/utils/strings";
import { deployContract } from "../scripts/utils/deployContract";
import L1DataFeeAnalyzer from "../scripts/utils/L1DataFeeAnalyzer";
import { deployContract, deployContractUsingContractFactory } from "../scripts/utils/deployContract";

const { AddressZero, WeiPerEther, MaxUint256, Zero } = ethers.constants;
const WeiPerUsdc = BN.from(1_000_000); // 6 decimals

let maxuint256  = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
let mintAmount1 = '101234567890123456789012345678901234567890123456789012345678901234567890123456'
let mintAmount2 = '109876543210987654321098765432109876543210987654321098765432109876543210987654'

let bytecode3 = undefined

describe("ContractFactory", function () {
  let deployer: SignerWithAddress;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  let user4: SignerWithAddress;
  let user5: SignerWithAddress;

  let contractFactory: ContractFactory;

  let chainID: number;
  let networkSettings: any;
  let snapshot: BN;

  let erc20a: ERC20;
  let erc20b: ERC20;
  let erc20c: ERC20;

  let l1DataFeeAnalyzer = new L1DataFeeAnalyzer();

  before(async function () {
    [deployer, owner, user1, user2, user3, user4, user5] = await ethers.getSigners();
    chainID = (await provider.getNetwork()).chainId;
    networkSettings = getNetworkSettings(chainID);
    if(!networkSettings.isTestnet) throw new Error("Do not run tests on production networks");
    snapshot = await provider.send("evm_snapshot", []);
    await deployer.sendTransaction({to:deployer.address}); // for some reason this helps solidity-coverage
  });

  after(async function () {
    await provider.send("evm_revert", [snapshot]);
  });

  describe("ContractFactory deployment", function () {
    it("should deploy factory successfully", async function () {
      contractFactory = await deployContract(deployer, "ContractFactory", []) as ContractFactory;
      await expectDeployed(contractFactory.address);
    });
  });

  describe("ContractFactory usage", function () {
    it("should deploy contracts successfully pt 1", async function () {
      let name = 'Test Token 1'
      let symbol = 'TEST'
      let decimals = 6
      erc20a = await deployContractUsingContractFactory(deployer, "MockERC20", [name, symbol, decimals], toBytes32(0), undefined, {}, 0, contractFactory.address);
      await expectDeployed(erc20a.address);
      expect(await erc20a.name()).eq(name)
      expect(await erc20a.symbol()).eq(symbol)
      expect(await erc20a.decimals()).eq(decimals)
      await erc20a.mint(user1.address, mintAmount1);
      expect(await erc20a.balanceOf(user1.address)).eq(mintAmount1);
    });
    it("should deploy contracts successfully pt 2", async function () {
      let name = 'Test Token 2'
      let symbol = 'TEST2'
      let decimals = 8
      let calldata = erc20a.interface.encodeFunctionData("mint", [user2.address, mintAmount2])
      erc20b = await deployContractUsingContractFactory(deployer, "MockERC20", [name, symbol, decimals], toBytes32(0), calldata, {}, 0, contractFactory.address);
      await expectDeployed(erc20b.address);
      expect(await erc20b.name()).eq(name)
      expect(await erc20b.symbol()).eq(symbol)
      expect(await erc20b.decimals()).eq(decimals)
      expect(await erc20b.balanceOf(user2.address)).eq(mintAmount2);
    });
    it("should deploy contracts successfully pt 3", async function () {
      let erc20Factory = await ethers.getContractFactory("MockERC20", deployer);
      let name = 'Test Token 3'
      let symbol = 'TEST3'
      let decimals = 12
      bytecode3 = erc20Factory.getDeployTransaction(name, symbol, decimals).data;
      let tx = await user1.sendTransaction({
        to: contractFactory.address,
        data: bytecode3,
        gasLimit: 5_000_000
      })
      let receipt = await tx.wait();
      if(!receipt.logs || receipt.logs.length == 0) {
        console.error("receipt")
        console.error(receipt)
        throw new Error("no events")
      }
      const createEvents = receipt.logs.filter(event=>event.address == contractFactory.address)
      if(createEvents.length > 1) {
        throw new error(`somehow created two contracts?`)
      }
      if(createEvents.length == 1) {
        let createEvent = createEvents[0]
        let topic = createEvent.topics[1]
        let contractAddress = '0x' + topic.substring(26)
        await expectDeployed(contractAddress);
        erc20c = await ethers.getContractAt("MockERC20", contractAddress);
        await expectDeployed(erc20c.address);
        expect(await erc20c.name()).eq(name)
        expect(await erc20c.symbol()).eq(symbol)
        expect(await erc20c.decimals()).eq(decimals)
        await erc20c.mint(user3.address, mintAmount1);
        expect(await erc20c.balanceOf(user3.address)).eq(mintAmount1);
      }
      if(createEvents.length == 0) {
        console.error("receipt")
        console.error(receipt)
        throw new Error("no matching events found")
      }
    });
    it("reverts if deploy fails - likely out of gas, bad constructor, or redeploy", async function () {
      let p = contractFactory.deploy(bytecode3, toBytes32(0))
      await expect(p).to.be.revertedWithCustomError(contractFactory, "ContractNotDeployed")
    })
  });

  describe("L1 gas fees", function () {
    it("calculate", async function () {
      l1DataFeeAnalyzer.analyze()
    });
  });
});
