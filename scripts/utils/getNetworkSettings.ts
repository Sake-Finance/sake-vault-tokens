// chainlist
// 1: ethereum
// 5: goerli
// 11155111: sepolia
// 137: polygon
// 80001: polygon mumbai
// 1313161554: aurora
// 1313161555: aurora testnet
// 84531: base goerli
// 84532: base sepolia
// 81457: blast mainnet
// 168587773: blast testnet
// 80084: berachain bartio
// 1868: soneium mainnet
// 1946: soneium minato
// 31337: hardhat testnet

// given a chainID, returns some settings to use for the network
export function getNetworkSettings(chainID: number) {
  const KNOWN_CHAINS = [1, 5, 11155111, 137, 80001, 1313161554, 1313161555, 8453, 84531, 84532, 81457, 168587773, 80084, 1868, 1946, 31337];
  if(!KNOWN_CHAINS.includes(chainID)) throw new Error(`chainID '${chainID}' unknown`);

  // number of blocks to wait to ensure finality
  const CONFIRMATIONS: any = {
    [1]: 1,
    [5]: 1,
    [11155111]: 1,
    [137]: 5,
    [80001]: 5,
    [1313161554]: 5,
    [1313161555]: 5,
    [8453]: 5,
    [84531]: 5,
    [84532]: 5,
    [81457]: 5,
    [168587773]: 5,
    [80084]: 5,
    [1868]: 5,
    [1946]: 5,
    [31337]: 0
  };
  let confirmations = CONFIRMATIONS.hasOwnProperty(chainID) ? CONFIRMATIONS[chainID] : 1;

  // gas settings
  const ONE_GWEI = 1000000000;
  const OVERRIDES: any = {
    [1]: {maxFeePerGas: 40 * ONE_GWEI, maxPriorityFeePerGas: 2 * ONE_GWEI},
    [5]: {},
    [11155111]: {},
    [137]: {maxFeePerGas: 31 * ONE_GWEI, maxPriorityFeePerGas: 31 * ONE_GWEI},
    [80001]: {maxFeePerGas: 2 * ONE_GWEI + 1, maxPriorityFeePerGas: 1 * ONE_GWEI},
    [1313161554]: {},
    [1313161555]: {},
    //[8453]: {},//{maxFeePerGas: 100, maxPriorityFeePerGas: 90},
    [8453]: {maxFeePerGas: 800, maxPriorityFeePerGas: 100},
    [84531]: {},//{maxFeePerGas: 100, maxPriorityFeePerGas: 90},
    [84532]: {},
    //[81457]: {maxFeePerGas: ONE_GWEI/10000, maxPriorityFeePerGas: ONE_GWEI/100000},
    [81457]: {maxFeePerGas: ONE_GWEI*7/10000, maxPriorityFeePerGas: ONE_GWEI/100000}, // default
    //[81457]: {maxFeePerGas: ONE_GWEI*170/10000, maxPriorityFeePerGas: ONE_GWEI/10000}, // gas increased
    //[81457]: {maxFeePerGas: ONE_GWEI*650/10000, maxPriorityFeePerGas: ONE_GWEI/10000}, // gas increased
    //[81457]: {maxFeePerGas: ONE_GWEI*300/10000, maxPriorityFeePerGas: ONE_GWEI/10000}, // gas increased
    //[81457]: {maxFeePerGas: ONE_GWEI*400/10000, maxPriorityFeePerGas: ONE_GWEI/10000}, // gas increased
    //[81457]: {maxFeePerGas: ONE_GWEI*2000/10000, maxPriorityFeePerGas: ONE_GWEI/10000}, // gas increased
    //[81457]: {maxFeePerGas: ONE_GWEI*2, maxPriorityFeePerGas: ONE_GWEI/100}, // to burn nonces / fix replacement fee
    [168587773]: {maxFeePerGas: 500, maxPriorityFeePerGas: 50},
    [80084]: {},
    [1868]: {maxFeePerGas: ONE_GWEI*0.12, maxPriorityFeePerGas: 50},
    [1946]: {maxFeePerGas: 5000, maxPriorityFeePerGas: 50},
    //[1946]: {maxFeePerGas: ONE_GWEI, maxPriorityFeePerGas: ONE_GWEI/10},
    [31337]: {},
  };
  let overrides = OVERRIDES.hasOwnProperty(chainID) ? OVERRIDES[chainID] : {};

  // testnets
  const TESTNETS: any = [5, 11155111, 80001, 1313161555, 84531, 84532, 80004, 1946, 31337];
  let isTestnet = TESTNETS.includes(chainID);

  // url of the provider
  const PROVIDER_URLS: any = {
    [1]: process.env.MAINNET_URL,
    [5]: process.env.GOERLI_URL,
    [11155111]: process.env.SEPOLIA_URL,
    [137]: process.env.POLYGON_URL,
    [80001]: process.env.MUMBAI_URL,
    [1313161554]: process.env.AURORA_URL,
    [1313161555]: process.env.AURORA_TESTNET_URL,
    [8453]: process.env.BASE_URL,
    [84531]: process.env.BASE_GOERLI_URL,
    [84532]: process.env.BASE_SEPOLIA_URL,
    [81457]: process.env.BLAST_URL,
    [168587773]: process.env.BLAST_SEPOLIA_URL,
    [80084]: process.env.BERACHAIN_BARTIO_URL,
    [1868]: process.env.SONEIUM_URL,
    [1946]: process.env.SONEIUM_MINATO_URL,
    [31337]: "" // technically this does have a url when forking. but we want this to fail if not listening to prod network
  }
  let providerURL = (PROVIDER_URLS.hasOwnProperty(chainID) ? PROVIDER_URLS[chainID] : "") || "";

  const ETHERSCAN_SETTINGS: any = {
    [1]: {url: "", apikey: process.env.ETHERSCAN_API_KEY},
    [5]: {url: "", apikey: process.env.ETHERSCAN_API_KEY},
    [137]: {url: "", apikey: process.env.POLYGONSCAN_API_KEY},
    [80001]: {url: "", apikey: process.env.POLYGONSCAN_API_KEY},
  }
  let etherscanSettings = ETHERSCAN_SETTINGS.hasOwnProperty(chainID) ? ETHERSCAN_SETTINGS[chainID] : undefined;

  let networkSettings = {confirmations, overrides, isTestnet, providerURL, etherscanSettings};
  return networkSettings;
}
