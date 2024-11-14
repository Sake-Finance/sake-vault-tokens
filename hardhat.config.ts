import { ethers } from "ethers";
ethers.BigNumber.prototype.toJSON = function toJSON(_key:any) { return this.toString() };
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-abi-exporter";
import "hardhat-contract-sizer";
import "@nomiclabs/hardhat-vyper";
import { config as dotenv_config } from "dotenv";
dotenv_config();
const USE_PROCESSED_FILES = process.env.USE_PROCESSED_FILES === "true";

const soneium_minato_fork = { url: process.env.SONEIUM_MINATO_URL||'', blockNumber:parseInt(process.env.SONEIUM_MINATO_FORK_BLOCK)||undefined };
const no_fork = undefined;
const forking = (
    process.env.FORK_NETWORK === "minato"         ? soneium_minato_fork
  : no_fork
);

const accounts = JSON.parse(process.env.PRIVATE_KEYS || '[]');

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      forking: process.env.FORK_NETWORK ? forking : undefined,
      chainId: Number(process.env.HARDHAT_CHAIN_ID ?? 31337),
    },
    localhost: { url: "http://127.0.0.1:8545" },
    minato: {
      url: process.env.SONEIUM_MINATO_URL||'',
      chainId: 1946,
      accounts: accounts
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200_000,
          },
        },
      },
    ]
  },
  paths: {
    sources: USE_PROCESSED_FILES ? "./contracts_processed" : "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  abiExporter: {
    path: "./abi",
    runOnCompile: true,
    clear: true,
    spacing: 0,
  },
  mocha: {
    timeout: 3600000, // one hour
  },
  gasReporter: {
    enabled: true,
    currency: "USD",
    gasPrice: 1, // really should be ~0.001 gwei, but this doesnt support decimals
    coinmarketcap: process.env.CMC_API_KEY || "",
  },
  etherscan: {
    apiKey: {
      "minato": "empty",
    },
    customChains: [
      {
        network: "minato",
        chainId: 1946,
        urls: {
          apiURL: "https://soneium-minato.blockscout.com/api",
          browserURL: "https://soneium-minato.blockscout.com"
        }
      }
    ]
  },
  vyper: {
    compilers: [
      {
        version: "0.2.4",
        settings: {
          optimize: "gas",
        },
      },
      {
        version: "0.2.8",
        settings: {
          optimize: "gas",
        },
      },
    ],
  },
};

export default config;
