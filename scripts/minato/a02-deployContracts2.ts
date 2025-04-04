import hardhat, { network } from "hardhat";
const { ethers } = hardhat;
const { provider } = ethers;
import { BigNumber as BN, BigNumberish } from "ethers";
import { config as dotenv_config } from "dotenv";
dotenv_config();
const accounts = JSON.parse(process.env.ACCOUNTS || "{}");

const sakevaultdeployerminato = new ethers.Wallet(accounts.sakevaultdeployerminato.key, provider);

import { ContractFactory, Multicall3, SakeProxyAdmin, SakeATokenVaultFactory, SakeATokenVault, MockERC20 } from "../../typechain-types";

import { delay } from "./../utils/misc";
import { isDeployed, expectDeployed } from "./../utils/expectDeployed";
import { logContractAddress } from "./../utils/logContractAddress";
import { getNetworkSettings } from "./../utils/getNetworkSettings";
import { deployContractUsingContractFactory, verifyContract } from "./../utils/deployContract";
import { toBytes32 } from "./../utils/setStorage";
import { getSelectors, FacetCutAction, calcSighash, calcSighashes, getCombinedAbi } from "./../utils/diamond"

const { AddressZero, WeiPerEther, MaxUint256 } = ethers.constants;
const Bytes32Zero = toBytes32(0);
const WeiPerUsdc = BN.from(1_000_000); // 6 decimals
const WeiPerWbtc = BN.from(100_000_000); // 8 decimals

let networkSettings: any;
let chainID: number;

const CONTRACT_FACTORY_ADDRESS        = "0x2eF7f9C8545cB13EEaBc10CFFA3481553C70Ffc8";
const MULTICALL3_ADDRESS              = "0xC494496757bB43B77B64cabe63aACF96A6c6A569";

const SAKE_PROXY_ADMIN_ADDRESS           = "0x45AF0c3F1e51Fb816A81EBbc0a449a2E2b38A264"; // v1.0.0
const SAKE_ATOKEN_VAULT_FACTORY_ADDRESS  = "0xAD10607410fb989b90aA6854A46DF1dBbc6CCa7b"; // v1.0.0

const POOL_ADDRESS = "0xEc38a5Cd88E87Fec0D10822DE8a3D6dB144931DA";
const referralCode = 0;

const WBTC_ADDRESS = "0x0ef029Fc24DC1368dfaE79b6943ec89874973d04";
const AWBTC_ADDRESS = "0x9BD455066AA7e8926217C3D6260f409fF20A967e";
const WAWBTC_IMPL_ADDRESS = "0xDdF0F6d7EF0b5a461430001a03Ae529E5D87De56"; // v1.0.0
const WAWBTC_ADDRESS = "0x4D2a041e0D0653663A0F0A555ac8F84C46A9d6c5"; // v1.0.0

const ASTR_ADDRESS = "0x26e6f7c7047252DdE3dcBF26AA492e6a264Db655";
const AASTR_ADDRESS = "0x704316Bde34C9f43805cd8c990ac13A6757F2Bb9";
const WAASTR_IMPL_ADDRESS = "0x04298C382fae97974B766646154F46ca7C455b9A"; // v1.0.0
const WAASTR_ADDRESS = "0xc9D95d453fD6Fad06D72dd9d45b8E6fe975428b9"; // v1.0.0


let proxyAdmin: SakeProxyAdmin;
let vaultFactory: SakeATokenVaultFactory;

let wawbtcImpl: SakeATokenVault;
let wawbtc: SakeATokenVault;

let waastrImpl: SakeATokenVault;
let waastr: SakeATokenVault;

let contractsToVerify = [] as any[]
let deploySalt = toBytes32(1946)

async function main() {
  console.log(`Using ${sakevaultdeployerminato.address} as sakevaultdeployerminato`);

  chainID = (await provider.getNetwork()).chainId;
  networkSettings = getNetworkSettings(chainID);
  function isChain(chainid: number, chainName: string) {
    return ((chainID === chainid) || ((chainID === 31337) && (process.env.FORK_NETWORK === chainName)));
  }
  if(!isChain(1946, "minato")) throw("Only run this on Soneium Minato Testnet or a local fork of Soneium Minato Testnet");

  await expectDeployed(CONTRACT_FACTORY_ADDRESS)
  await expectDeployed(SAKE_PROXY_ADMIN_ADDRESS)
  await expectDeployed(SAKE_ATOKEN_VAULT_FACTORY_ADDRESS)
  proxyAdmin = await ethers.getContractAt("SakeProxyAdmin", SAKE_PROXY_ADMIN_ADDRESS, sakevaultdeployerminato) as SakeProxyAdmin;
  vaultFactory = await ethers.getContractAt("SakeATokenVaultFactory", SAKE_ATOKEN_VAULT_FACTORY_ADDRESS, sakevaultdeployerminato) as SakeATokenVaultFactory;

  await deploy_wawbtcImpl();
  await deploy_wawbtc();

  await deploy_waastrImpl();
  await deploy_waastr();

  await verifyContracts();
  logAddresses()
}

async function deploy_wawbtcImpl() {
  if(await isDeployed(WAWBTC_IMPL_ADDRESS)) {
    wawbtcImpl = await ethers.getContractAt("SakeATokenVault", WAWBTC_IMPL_ADDRESS, sakevaultdeployerminato) as SakeATokenVault;
  } else {
    console.log("Deploying waWBTC impl");
    let args = [WBTC_ADDRESS, AWBTC_ADDRESS, POOL_ADDRESS, referralCode];
    wawbtcImpl = await deployContractUsingContractFactory(sakevaultdeployerminato, "SakeATokenVault", args, deploySalt, undefined, {...networkSettings.overrides, gasLimit: 5_000_000}, networkSettings.confirmations) as SakeATokenVault;
    console.log(`Deployed waWBTC impl to ${wawbtcImpl.address}`);
    contractsToVerify.push({ address: wawbtcImpl.address, args })
    if(!!WAWBTC_IMPL_ADDRESS && wawbtcImpl.address != WAWBTC_IMPL_ADDRESS) throw new Error(`Deployed waWBTC impl to ${wawbtcImpl.address}, expected ${WAWBTC_IMPL_ADDRESS}`)
  }
}

async function deploy_wawbtc() {
  if(await isDeployed(WAWBTC_ADDRESS)) {
    wawbtc = await ethers.getContractAt("SakeATokenVault", WAWBTC_ADDRESS, sakevaultdeployerminato) as SakeATokenVault;
  } else {
    console.log("Deploying waWBTC");
    let useAToken = false
    let initialDepositAmount = WeiPerWbtc.mul(1).div(1000)
    if(useAToken) await checkBalanceAndAllowance(sakevaultdeployerminato, AWBTC_ADDRESS, initialDepositAmount)
    else await checkBalanceAndAllowance(sakevaultdeployerminato, WBTC_ADDRESS, initialDepositAmount)
    let name = "ERC4626-Wrapped Sake aWBTC"
    let symbol = "waWBTC"
    let predictedAddress = await vaultFactory.connect(sakevaultdeployerminato).callStatic.createVault(
      wawbtcImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployerminato.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    console.log(`predicted address ${predictedAddress}`);
    let tx = await vaultFactory.connect(sakevaultdeployerminato).createVault(
      wawbtcImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployerminato.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    const receipt = await tx.wait(networkSettings.confirmations)
    console.log(`Gas used to deploy contract: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    wawbtc = await ethers.getContractAt("SakeATokenVault", predictedAddress, sakevaultdeployerminato) as SakeATokenVault;
    console.log(`Deployed waWBTC to ${wawbtc.address}`);
    
    let deployData = wawbtc.interface.encodeFunctionData("initialize", [SAKE_PROXY_ADMIN_ADDRESS, "waWBTC", "waWBTC"])
    let verifyArgs = [wawbtcImpl.address, SAKE_PROXY_ADMIN_ADDRESS, deployData]
    contractsToVerify.push({ address: wawbtc.address, args: verifyArgs })
    if(!!WAWBTC_ADDRESS && wawbtc.address != WAWBTC_ADDRESS) throw new Error(`Deployed waWBTC to ${wawbtc.address}, expected ${WAWBTC_ADDRESS}`)
  }
}

async function deploy_waastrImpl() {
  if(await isDeployed(WAASTR_IMPL_ADDRESS)) {
    waastrImpl = await ethers.getContractAt("SakeATokenVault", WAASTR_IMPL_ADDRESS, sakevaultdeployerminato) as SakeATokenVault;
  } else {
    console.log("Deploying waASTR impl");
    let args = [ASTR_ADDRESS, AASTR_ADDRESS, POOL_ADDRESS, referralCode];
    waastrImpl = await deployContractUsingContractFactory(sakevaultdeployerminato, "SakeATokenVault", args, deploySalt, undefined, {...networkSettings.overrides, gasLimit: 5_000_000}, networkSettings.confirmations) as SakeATokenVault;
    console.log(`Deployed waASTR impl to ${waastrImpl.address}`);
    contractsToVerify.push({ address: waastrImpl.address, args })
    if(!!WAASTR_IMPL_ADDRESS && waastrImpl.address != WAASTR_IMPL_ADDRESS) throw new Error(`Deployed waASTR impl to ${waastrImpl.address}, expected ${WAASTR_IMPL_ADDRESS}`)
  }
}

async function deploy_waastr() {
  if(await isDeployed(WAASTR_ADDRESS)) {
    waastr = await ethers.getContractAt("SakeATokenVault", WAASTR_ADDRESS, sakevaultdeployerminato) as SakeATokenVault;
  } else {
    console.log("Deploying waASTR");
    let useAToken = false
    let initialDepositAmount = WeiPerEther.mul(500)
    if(useAToken) await checkBalanceAndAllowance(sakevaultdeployerminato, AASTR_ADDRESS, initialDepositAmount)
    else await checkBalanceAndAllowance(sakevaultdeployerminato, ASTR_ADDRESS, initialDepositAmount)
    let name = "ERC4626-Wrapped Sake aASTR"
    let symbol = "waASTR"
    let predictedAddress = await vaultFactory.connect(sakevaultdeployerminato).callStatic.createVault(
      waastrImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployerminato.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    console.log(`predicted address ${predictedAddress}`);
    let tx = await vaultFactory.connect(sakevaultdeployerminato).createVault(
      waastrImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployerminato.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    const receipt = await tx.wait(networkSettings.confirmations)
    console.log(`Gas used to deploy contract: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    waastr = await ethers.getContractAt("SakeATokenVault", predictedAddress, sakevaultdeployerminato) as SakeATokenVault;
    console.log(`Deployed waASTR to ${waastr.address}`);
    
    let deployData = waastr.interface.encodeFunctionData("initialize", [SAKE_PROXY_ADMIN_ADDRESS, "waASTR", "waASTR"])
    let verifyArgs = [waastrImpl.address, SAKE_PROXY_ADMIN_ADDRESS, deployData]
    contractsToVerify.push({ address: waastr.address, args: verifyArgs })
    if(!!WAASTR_ADDRESS && waastr.address != WAASTR_ADDRESS) throw new Error(`Deployed waASTR to ${waastr.address}, expected ${WAASTR_ADDRESS}`)
  }
}

async function checkBalanceAndAllowance(creator: any, tokenAddress: string, amount: BigNumberish) {
  let amt = BN.from(amount)
  let token = await ethers.getContractAt("MockERC20", tokenAddress, creator) as MockERC20;
  let balance = await token.balanceOf(creator.address);
  if(balance.lt(amount)) throw new Error(`Insufficient balance of ${token.address} for ${creator.address}. Expected ${amt.toString()} have ${balance.toString()}`)
  let allowance = await token.allowance(creator.address, SAKE_ATOKEN_VAULT_FACTORY_ADDRESS);
  if(allowance.lt(amount)) {
    console.log(`approving token ...`)
    let tx = await token.connect(creator).approve(SAKE_ATOKEN_VAULT_FACTORY_ADDRESS, MaxUint256, {...networkSettings.overrides, gasLimit: 100_000});
    await tx.wait(networkSettings.confirmations)
    console.log(`approved`)
  }
}

async function verifyContracts() {
  if(chainID == 31337) return
  if(contractsToVerify.length == 0) return
  console.log(`verifying ${contractsToVerify.length} contracts`)
  await delay(30_000); // likely just deployed a contract, let etherscan index it
  for(let i = 0; i < contractsToVerify.length; i++) {
    let { address, args, contractName } = contractsToVerify[i]
    await verifyContract(address, args, contractName);
  }
}

function logAddresses() {
  console.log("");
  console.log("| Contract Name                        | Address                                      |");
  console.log("|--------------------------------------|----------------------------------------------|");
  logContractAddress("SakeProxyAdmin", proxyAdmin.address);
  logContractAddress("SakeATokenVaultFactory", vaultFactory.address);
  logContractAddress("waWBTC impl", wawbtcImpl.address);
  logContractAddress("waWBTC", wawbtc.address);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
  });
