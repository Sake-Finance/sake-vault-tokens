import hardhat, { network } from "hardhat";
const { ethers } = hardhat;
const { provider } = ethers;
import { BigNumber as BN, BigNumberish } from "ethers";
import { config as dotenv_config } from "dotenv";
dotenv_config();
const accounts = JSON.parse(process.env.ACCOUNTS || "{}");

const sakevaultdeployersoneium = new ethers.Wallet(accounts.sakevaultdeployersoneium.key, provider);

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
const MULTICALL3_ADDRESS              = "0xB981161Be7D05d7a291Ffa5CE32c2771422De385";

const SAKE_PROXY_ADMIN_ADDRESS           = "0xa97467d6A8A12eD968309bE8ce8f39575A1B90F2"; // v1.0.0
const SAKE_ATOKEN_VAULT_FACTORY_ADDRESS  = "0x354A4aF4d70667b70634f64B9e96986a8914476e"; // v1.0.0

const POOL_ADDRESS = "0x3C3987A310ee13F7B8cBBe21D97D4436ba5E4B5f";
const referralCode = 0;

const WBTC_ADDRESS = "";
const AWBTC_ADDRESS = "";
const WAWBTC_IMPL_ADDRESS = ""; // v1.0.0
const WAWBTC_ADDRESS = ""; // v1.0.0

const ASTR_ADDRESS = "";
const AASTR_ADDRESS = "";
const WAASTR_IMPL_ADDRESS = ""; // v1.0.0
const WAASTR_ADDRESS = ""; // v1.0.0

const USDCE_ADDRESS = "0xbA9986D2381edf1DA03B0B9c1f8b00dc4AacC369";
const AUSDCE_ADDRESS = "0x4491B60c8fdD668FcC2C4dcADf9012b3fA71a726";
const WAUSDCE_IMPL_ADDRESS = "0x215Ee4A39089266519a729f1e53dDFAd7fA8E009"; // v1.0.0
const WAUSDCE_ADDRESS = "0xeCb6b2395f72c3685e7D322Bfc7179a5F230fa17"; // v1.0.0

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
const AWETH_ADDRESS = "0x4DC7c9eC156188Ea46F645E8407738C32c2B5B58";
const WAWETH_IMPL_ADDRESS = "0x7DF0E75F3b7ebc957d9494A103ffD6fdcb5517FD"; // v1.0.0
const WAWETH_ADDRESS = "0xa923169A4DBcbA35B80208dB3732998F5AB54517"; // v1.0.0

let proxyAdmin: SakeProxyAdmin;
let vaultFactory: SakeATokenVaultFactory;

let wawbtcImpl: SakeATokenVault;
let wawbtc: SakeATokenVault;

let waastrImpl: SakeATokenVault;
let waastr: SakeATokenVault;

let wausdceImpl: SakeATokenVault;
let wausdce: SakeATokenVault;

let wawethImpl: SakeATokenVault;
let waweth: SakeATokenVault;

let contractsToVerify = [] as any[]
let deploySalt = toBytes32(1868)

async function main() {
  console.log(`Using ${sakevaultdeployersoneium.address} as sakevaultdeployersoneium`);

  chainID = (await provider.getNetwork()).chainId;
  networkSettings = getNetworkSettings(chainID);
  function isChain(chainid: number, chainName: string) {
    return ((chainID === chainid) || ((chainID === 31337) && (process.env.FORK_NETWORK === chainName)));
  }
  if(!isChain(1868, "soneium")) throw("Only run this on Soneium Mainnet or a local fork of Soneium Mainnet");

  await expectDeployed(CONTRACT_FACTORY_ADDRESS)
  await expectDeployed(SAKE_PROXY_ADMIN_ADDRESS)
  await expectDeployed(SAKE_ATOKEN_VAULT_FACTORY_ADDRESS)
  proxyAdmin = await ethers.getContractAt("SakeProxyAdmin", SAKE_PROXY_ADMIN_ADDRESS, sakevaultdeployersoneium) as SakeProxyAdmin;
  vaultFactory = await ethers.getContractAt("SakeATokenVaultFactory", SAKE_ATOKEN_VAULT_FACTORY_ADDRESS, sakevaultdeployersoneium) as SakeATokenVaultFactory;

  //await deploy_wawbtcImpl();
  //await deploy_wawbtc();

  //await deploy_waastrImpl();
  //await deploy_waastr();

  await deploy_wausdceImpl();
  await deploy_wausdce();

  await deploy_wawethImpl();
  await deploy_waweth();

  //await verifyContracts();
  logAddresses()
}

async function deploy_wawbtcImpl() {
  if(await isDeployed(WAWBTC_IMPL_ADDRESS)) {
    wawbtcImpl = await ethers.getContractAt("SakeATokenVault", WAWBTC_IMPL_ADDRESS, sakevaultdeployersoneium) as SakeATokenVault;
  } else {
    console.log("Deploying waWBTC impl");
    let args = [WBTC_ADDRESS, AWBTC_ADDRESS, POOL_ADDRESS, referralCode];
    wawbtcImpl = await deployContractUsingContractFactory(sakevaultdeployersoneium, "SakeATokenVault", args, deploySalt, undefined, {...networkSettings.overrides, gasLimit: 5_000_000}, networkSettings.confirmations) as SakeATokenVault;
    console.log(`Deployed waWBTC impl to ${wawbtcImpl.address}`);
    contractsToVerify.push({ address: wawbtcImpl.address, args })
    if(!!WAWBTC_IMPL_ADDRESS && wawbtcImpl.address != WAWBTC_IMPL_ADDRESS) throw new Error(`Deployed waWBTC impl to ${wawbtcImpl.address}, expected ${WAWBTC_IMPL_ADDRESS}`)
  }
}

async function deploy_wawbtc() {
  if(await isDeployed(WAWBTC_ADDRESS)) {
    wawbtc = await ethers.getContractAt("SakeATokenVault", WAWBTC_ADDRESS, sakevaultdeployersoneium) as SakeATokenVault;
  } else {
    console.log("Deploying waWBTC");
    let useAToken = false
    let initialDepositAmount = WeiPerWbtc.mul(1).div(1000)
    if(useAToken) await checkBalanceAndAllowance(sakevaultdeployersoneium, AWBTC_ADDRESS, initialDepositAmount)
    else await checkBalanceAndAllowance(sakevaultdeployersoneium, WBTC_ADDRESS, initialDepositAmount)
    let name = "ERC4626-Wrapped Sake aWBTC"
    let symbol = "waWBTC"
    let predictedAddress = await vaultFactory.connect(sakevaultdeployersoneium).callStatic.createVault(
      wawbtcImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployersoneium.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    console.log(`predicted address ${predictedAddress}`);
    let tx = await vaultFactory.connect(sakevaultdeployersoneium).createVault(
      wawbtcImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployersoneium.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    const receipt = await tx.wait(networkSettings.confirmations)
    console.log(`Gas used to deploy contract: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    wawbtc = await ethers.getContractAt("SakeATokenVault", predictedAddress, sakevaultdeployersoneium) as SakeATokenVault;
    console.log(`Deployed waWBTC to ${wawbtc.address}`);
    
    let deployData = wawbtc.interface.encodeFunctionData("initialize", [SAKE_PROXY_ADMIN_ADDRESS, "waWBTC", "waWBTC"])
    let verifyArgs = [wawbtcImpl.address, SAKE_PROXY_ADMIN_ADDRESS, deployData]
    contractsToVerify.push({ address: wawbtc.address, args: verifyArgs })
    if(!!WAWBTC_ADDRESS && wawbtc.address != WAWBTC_ADDRESS) throw new Error(`Deployed waWBTC to ${wawbtc.address}, expected ${WAWBTC_ADDRESS}`)
  }
}

async function deploy_waastrImpl() {
  if(await isDeployed(WAASTR_IMPL_ADDRESS)) {
    waastrImpl = await ethers.getContractAt("SakeATokenVault", WAASTR_IMPL_ADDRESS, sakevaultdeployersoneium) as SakeATokenVault;
  } else {
    console.log("Deploying waASTR impl");
    let args = [ASTR_ADDRESS, AASTR_ADDRESS, POOL_ADDRESS, referralCode];
    waastrImpl = await deployContractUsingContractFactory(sakevaultdeployersoneium, "SakeATokenVault", args, deploySalt, undefined, {...networkSettings.overrides, gasLimit: 5_000_000}, networkSettings.confirmations) as SakeATokenVault;
    console.log(`Deployed waASTR impl to ${waastrImpl.address}`);
    contractsToVerify.push({ address: waastrImpl.address, args })
    if(!!WAASTR_IMPL_ADDRESS && waastrImpl.address != WAASTR_IMPL_ADDRESS) throw new Error(`Deployed waASTR impl to ${waastrImpl.address}, expected ${WAASTR_IMPL_ADDRESS}`)
  }
}

async function deploy_waastr() {
  if(await isDeployed(WAASTR_ADDRESS)) {
    waastr = await ethers.getContractAt("SakeATokenVault", WAASTR_ADDRESS, sakevaultdeployersoneium) as SakeATokenVault;
  } else {
    console.log("Deploying waASTR");
    let useAToken = false
    let initialDepositAmount = WeiPerEther.mul(500)
    if(useAToken) await checkBalanceAndAllowance(sakevaultdeployersoneium, AASTR_ADDRESS, initialDepositAmount)
    else await checkBalanceAndAllowance(sakevaultdeployersoneium, ASTR_ADDRESS, initialDepositAmount)
    let name = "ERC4626-Wrapped Sake aASTR"
    let symbol = "waASTR"
    let predictedAddress = await vaultFactory.connect(sakevaultdeployersoneium).callStatic.createVault(
      waastrImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployersoneium.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    console.log(`predicted address ${predictedAddress}`);
    let tx = await vaultFactory.connect(sakevaultdeployersoneium).createVault(
      waastrImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployersoneium.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    const receipt = await tx.wait(networkSettings.confirmations)
    console.log(`Gas used to deploy contract: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    waastr = await ethers.getContractAt("SakeATokenVault", predictedAddress, sakevaultdeployersoneium) as SakeATokenVault;
    console.log(`Deployed waASTR to ${waastr.address}`);
    
    let deployData = waastr.interface.encodeFunctionData("initialize", [SAKE_PROXY_ADMIN_ADDRESS, "waASTR", "waASTR"])
    let verifyArgs = [waastrImpl.address, SAKE_PROXY_ADMIN_ADDRESS, deployData]
    contractsToVerify.push({ address: waastr.address, args: verifyArgs })
    if(!!WAASTR_ADDRESS && waastr.address != WAASTR_ADDRESS) throw new Error(`Deployed waASTR to ${waastr.address}, expected ${WAASTR_ADDRESS}`)
  }
}

async function deploy_wausdceImpl() {
  if(await isDeployed(WAUSDCE_IMPL_ADDRESS)) {
    wausdceImpl = await ethers.getContractAt("SakeATokenVault", WAUSDCE_IMPL_ADDRESS, sakevaultdeployersoneium) as SakeATokenVault;
  } else {
    console.log("Deploying waUSDCE impl");
    let args = [USDCE_ADDRESS, AUSDCE_ADDRESS, POOL_ADDRESS, referralCode];
    wausdceImpl = await deployContractUsingContractFactory(sakevaultdeployersoneium, "SakeATokenVault", args, deploySalt, undefined, {...networkSettings.overrides, gasLimit: 5_000_000}, networkSettings.confirmations) as SakeATokenVault;
    console.log(`Deployed waUSDCE impl to ${wausdceImpl.address}`);
    contractsToVerify.push({ address: wausdceImpl.address, args })
    if(!!WAUSDCE_IMPL_ADDRESS && wausdceImpl.address != WAUSDCE_IMPL_ADDRESS) throw new Error(`Deployed waUSDCE impl to ${wausdceImpl.address}, expected ${WAUSDCE_IMPL_ADDRESS}`)
  }
}

async function deploy_wausdce() {
  if(await isDeployed(WAUSDCE_ADDRESS)) {
    wausdce = await ethers.getContractAt("SakeATokenVault", WAUSDCE_ADDRESS, sakevaultdeployersoneium) as SakeATokenVault;
  } else {
    console.log("Deploying waUSDCE");
    let useAToken = true
    let initialDepositAmount = WeiPerUsdc.mul(20)
    if(useAToken) await checkBalanceAndAllowance(sakevaultdeployersoneium, AUSDCE_ADDRESS, initialDepositAmount)
    else await checkBalanceAndAllowance(sakevaultdeployersoneium, USDCE_ADDRESS, initialDepositAmount)
    let name = "ERC4626-Wrapped Sake aUSDC.e"
    let symbol = "waUSDC.e"
    let predictedAddress = await vaultFactory.connect(sakevaultdeployersoneium).callStatic.createVault(
      wausdceImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployersoneium.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    console.log(`predicted address ${predictedAddress}`);
    let tx = await vaultFactory.connect(sakevaultdeployersoneium).createVault(
      wausdceImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployersoneium.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    const receipt = await tx.wait(networkSettings.confirmations)
    console.log(`Gas used to deploy contract: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    wausdce = await ethers.getContractAt("SakeATokenVault", predictedAddress, sakevaultdeployersoneium) as SakeATokenVault;
    console.log(`Deployed waUSDCE to ${wausdce.address}`);
    
    let deployData = wausdce.interface.encodeFunctionData("initialize", [SAKE_PROXY_ADMIN_ADDRESS, "waUSDCE", "waUSDCE"])
    let verifyArgs = [wausdceImpl.address, SAKE_PROXY_ADMIN_ADDRESS, deployData]
    contractsToVerify.push({ address: wausdce.address, args: verifyArgs })
    if(!!WAUSDCE_ADDRESS && wausdce.address != WAUSDCE_ADDRESS) throw new Error(`Deployed waUSDCE to ${wausdce.address}, expected ${WAUSDCE_ADDRESS}`)
  }
}

async function deploy_wawethImpl() {
  if(await isDeployed(WAWETH_IMPL_ADDRESS)) {
    wawethImpl = await ethers.getContractAt("SakeATokenVault", WAWETH_IMPL_ADDRESS, sakevaultdeployersoneium) as SakeATokenVault;
  } else {
    console.log("Deploying waWETH impl");
    let args = [WETH_ADDRESS, AWETH_ADDRESS, POOL_ADDRESS, referralCode];
    wawethImpl = await deployContractUsingContractFactory(sakevaultdeployersoneium, "SakeATokenVault", args, deploySalt, undefined, {...networkSettings.overrides, gasLimit: 5_000_000}, networkSettings.confirmations) as SakeATokenVault;
    console.log(`Deployed waWETH impl to ${wawethImpl.address}`);
    contractsToVerify.push({ address: wawethImpl.address, args })
    if(!!WAWETH_IMPL_ADDRESS && wawethImpl.address != WAWETH_IMPL_ADDRESS) throw new Error(`Deployed waWETH impl to ${wawethImpl.address}, expected ${WAWETH_IMPL_ADDRESS}`)
  }
}

async function deploy_waweth() {
  if(await isDeployed(WAWETH_ADDRESS)) {
    waweth = await ethers.getContractAt("SakeATokenVault", WAWETH_ADDRESS, sakevaultdeployersoneium) as SakeATokenVault;
  } else {
    console.log("Deploying waWETH");
    let useAToken = true
    let initialDepositAmount = WeiPerEther.mul(11).div(1000)
    if(useAToken) await checkBalanceAndAllowance(sakevaultdeployersoneium, AWETH_ADDRESS, initialDepositAmount)
    else await checkBalanceAndAllowance(sakevaultdeployersoneium, WETH_ADDRESS, initialDepositAmount)
    let name = "ERC4626-Wrapped Sake aWETH"
    let symbol = "waWETH"
    let predictedAddress = await vaultFactory.connect(sakevaultdeployersoneium).callStatic.createVault(
      wawethImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployersoneium.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    console.log(`predicted address ${predictedAddress}`);
    let tx = await vaultFactory.connect(sakevaultdeployersoneium).createVault(
      wawethImpl.address,
      SAKE_PROXY_ADMIN_ADDRESS,
      sakevaultdeployersoneium.address,
      toBytes32(0),
      name,
      symbol,
      useAToken,
      initialDepositAmount,
      {...networkSettings.overrides, gasLimit: 2_000_000}
    )
    const receipt = await tx.wait(networkSettings.confirmations)
    console.log(`Gas used to deploy contract: ${receipt.gasUsed.toNumber().toLocaleString()}`)
    waweth = await ethers.getContractAt("SakeATokenVault", predictedAddress, sakevaultdeployersoneium) as SakeATokenVault;
    console.log(`Deployed waWETH to ${waweth.address}`);
    
    let deployData = waweth.interface.encodeFunctionData("initialize", [SAKE_PROXY_ADMIN_ADDRESS, "waWETH", "waWETH"])
    let verifyArgs = [wawethImpl.address, SAKE_PROXY_ADMIN_ADDRESS, deployData]
    contractsToVerify.push({ address: waweth.address, args: verifyArgs })
    if(!!WAWETH_ADDRESS && waweth.address != WAWETH_ADDRESS) throw new Error(`Deployed waWETH to ${waweth.address}, expected ${WAWETH_ADDRESS}`)
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
  //logContractAddress("waWBTC impl", wawbtcImpl.address);
  //logContractAddress("waWBTC", wawbtc.address);
  logContractAddress("waUSDC.e impl", wausdceImpl.address);
  logContractAddress("waUSDC.e", wausdce.address);
  logContractAddress("waWETH impl", wawethImpl.address);
  logContractAddress("waWETH", waweth.address);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
  });
