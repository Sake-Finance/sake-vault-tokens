import hardhat from "hardhat";
const { ethers } = hardhat;
const { provider } = ethers;
import { BigNumber as BN, BigNumberish } from "ethers";
import { config as dotenv_config } from "dotenv";
dotenv_config();
const accounts = JSON.parse(process.env.ACCOUNTS || "{}");

const sakevaultdeployersoneium = new ethers.Wallet(accounts.sakevaultdeployersoneium.key, provider);

import { ContractFactory, Multicall3, SakeProxyAdmin, SakeATokenVaultFactory } from "../../typechain-types";

import { delay } from "./../utils/misc";
import { isDeployed, expectDeployed } from "./../utils/expectDeployed";
import { logContractAddress } from "./../utils/logContractAddress";
import { getNetworkSettings } from "./../utils/getNetworkSettings";
import { deployContractUsingContractFactory, verifyContract } from "./../utils/deployContract";
import { toBytes32 } from "./../utils/setStorage";
import { getSelectors, FacetCutAction, calcSighash, calcSighashes, getCombinedAbi } from "./../utils/diamond"

const { AddressZero, WeiPerEther, MaxUint256 } = ethers.constants;

let networkSettings: any;
let chainID: number;

const CONTRACT_FACTORY_ADDRESS        = "0x2eF7f9C8545cB13EEaBc10CFFA3481553C70Ffc8";
const MULTICALL3_ADDRESS              = "0xB981161Be7D05d7a291Ffa5CE32c2771422De385";

const SAKE_PROXY_ADMIN_ADDRESS           = "0xa97467d6A8A12eD968309bE8ce8f39575A1B90F2"; // v1.0.0
const SAKE_ATOKEN_VAULT_FACTORY_ADDRESS  = "0x354A4aF4d70667b70634f64B9e96986a8914476e"; // v1.0.0

let proxyAdmin: SakeProxyAdmin;
let vaultFactory: SakeATokenVaultFactory;

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

  await deploySakeProxyAdmin();
  await deploySakeATokenVaultFactory();
  //await deploySakeTransparentUpgradeableProxy();

  await verifyContracts();
  logAddresses()
}

async function deploySakeProxyAdmin() {
  if(await isDeployed(SAKE_PROXY_ADMIN_ADDRESS)) {
    proxyAdmin = await ethers.getContractAt("SakeProxyAdmin", SAKE_PROXY_ADMIN_ADDRESS, sakevaultdeployersoneium) as SakeProxyAdmin;
  } else {
    console.log("Deploying SakeProxyAdmin");
    let args = [sakevaultdeployersoneium.address];
    proxyAdmin = await deployContractUsingContractFactory(sakevaultdeployersoneium, "SakeProxyAdmin", args, deploySalt, undefined, {...networkSettings.overrides, gasLimit: 1_000_000}, networkSettings.confirmations) as SakeProxyAdmin;
    console.log(`Deployed SakeProxyAdmin to ${proxyAdmin.address}`);
    //contractsToVerify.push({ address: proxyAdmin.address, args })
    if(!!SAKE_PROXY_ADMIN_ADDRESS && proxyAdmin.address != SAKE_PROXY_ADMIN_ADDRESS) throw new Error(`Deployed SakeProxyAdmin to ${proxyAdmin.address}, expected ${SAKE_PROXY_ADMIN_ADDRESS}`)
  }
}

async function deploySakeATokenVaultFactory() {
  if(await isDeployed(SAKE_ATOKEN_VAULT_FACTORY_ADDRESS)) {
    vaultFactory = await ethers.getContractAt("SakeATokenVaultFactory", SAKE_ATOKEN_VAULT_FACTORY_ADDRESS, sakevaultdeployersoneium) as SakeATokenVaultFactory;
  } else {
    console.log("Deploying SakeATokenVaultFactory");
    let args = [sakevaultdeployersoneium.address];
    vaultFactory = await deployContractUsingContractFactory(sakevaultdeployersoneium, "SakeATokenVaultFactory", args, deploySalt, undefined, {...networkSettings.overrides, gasLimit: 2_000_000}, networkSettings.confirmations) as SakeATokenVaultFactory;
    console.log(`Deployed SakeATokenVaultFactory to ${vaultFactory.address}`);
    //contractsToVerify.push({ address: vaultFactory.address, args })
    if(!!SAKE_ATOKEN_VAULT_FACTORY_ADDRESS && vaultFactory.address != SAKE_ATOKEN_VAULT_FACTORY_ADDRESS) throw new Error(`Deployed SakeATokenVaultFactory to ${vaultFactory.address}, expected ${SAKE_ATOKEN_VAULT_FACTORY_ADDRESS}`)
  }
}

/*
async function deploySakeTransparentUpgradeableProxy() {
  //if(await isDeployed(SAKE_ATOKEN_VAULT_FACTORY_ADDRESS)) {
    //proxy = await ethers.getContractAt("SakeTransparentUpgradeableProxy", SAKE_ATOKEN_VAULT_FACTORY_ADDRESS, sakevaultdeployersoneium) as SakeTransparentUpgradeableProxy;
  //} else {
    let addr = "0x2b75F206f3591A504bbf3280E3a5bf4fF476ecE1"
    let proxy = await ethers.getContractAt("SakeTransparentUpgradeableProxy", addr, sakevaultdeployersoneium) as SakeTransparentUpgradeableProxy;

    console.log("Deploying SakeTransparentUpgradeableProxy");
    let args = [MULTICALL3_ADDRESS, proxyAdmin.address, "0x"];
    //let proxy = await deployContractUsingContractFactory(sakevaultdeployersoneium, "SakeTransparentUpgradeableProxy", args, deploySalt, undefined, {...networkSettings.overrides, gasLimit: 2_000_000}, networkSettings.confirmations) as SakeTransparentUpgradeableProxy;
    console.log(`Deployed SakeTransparentUpgradeableProxy to ${proxy.address}`);
    contractsToVerify.push({ address: proxy.address, args, contractName: "contracts/proxy/SakeTransparentUpgradeableProxy.sol:SakeTransparentUpgradeableProxy" })
    //if(!!SAKE_ATOKEN_VAULT_FACTORY_ADDRESS && proxy.address != SAKE_ATOKEN_VAULT_FACTORY_ADDRESS) throw new Error(`Deployed SakeTransparentUpgradeableProxy to ${proxy.address}, expected ${SAKE_ATOKEN_VAULT_FACTORY_ADDRESS}`)
  //}
}
*/

async function verifyContracts() {
  if(chainID == 31337) return
  if(contractsToVerify.length == 0) return
  console.log(`verifying ${contractsToVerify.length} contracts`)
  //await delay(30_000); // likely just deployed a contract, let etherscan index it
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
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
  });
