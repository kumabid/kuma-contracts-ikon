import * as dotenv from 'dotenv';

import '@typechain/hardhat';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-chai-matchers';
import '@nomicfoundation/hardhat-verify';
import 'hardhat-contract-sizer';
import 'solidity-coverage';
import type { HardhatUserConfig } from 'hardhat/config';

dotenv.config();

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

const SOLC_VERSION = '0.8.18';

const SOLC_VERSION_LAYERZERO = '0.8.25';

// https://hardhat.org/hardhat-runner/docs/reference/solidity-support#support-for-ir-based-codegen
const minimalOptimizerSettings = {
  viaIR: true,
  optimizer: {
    enabled: true,
    details: {
      yulDetails: {
        optimizerSteps: 'u',
      },
    },
  },
};

const solidity = {
  compilers: [
    {
      version: SOLC_VERSION,
      settings: !!process.env.COVERAGE
        ? minimalOptimizerSettings
        : {
            optimizer: {
              enabled: true,
              runs: 1000000,
            },
            viaIR: true,
          },
    },
    {
      version: SOLC_VERSION_LAYERZERO,
      settings: !!process.env.COVERAGE
        ? minimalOptimizerSettings
        : {
            optimizer: {
              enabled: true,
              runs: 1000000,
            },
            viaIR: true,
          },
    },
  ],
  overrides: {
    'contracts/Exchange.sol': {
      version: SOLC_VERSION,
      settings: !!process.env.COVERAGE
        ? minimalOptimizerSettings
        : {
            optimizer: {
              enabled: true,
              runs: 100,
            },
            viaIR: true,
          },
    },
  },
};

const config: HardhatUserConfig = {
  solidity,
  mocha: {
    timeout: 100000000,
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: !!process.env.COVERAGE,
    },
    berachain: {
      chainId: 80094,
      url: 'https://rpc.berachain.com/',
    },
    cArtio: {
      chainId: 80000,
      url: 'https://rockbeard-eth-cartio.berachain.com/',
    },
    xchain: {
      chainId: 94524,
      url: 'https://xchain-rpc.kuma.bid',
    },
    xchainTestnet: {
      chainId: 64002,
      url: 'https://xchain-testnet-rpc.kuma.bid/',
    },
    sepolia: {
      chainId: 11155111,
      url: 'https://eth-sepolia.g.alchemy.com/v2/Mb9MWMHYaVtzPEzAmo_UCdUHdtRyrSvj',
    },
  },
  etherscan: {
    apiKey: {
      cArtio: 'abc',
      xchain: 'abc',
      xchainTestnet: 'abc',
      sepolia: 'KAMGRM9Z7P1I58TTEBCHI6J9K583QCFZRR',
    },
    customChains: [
      {
        network: 'berachain',
        chainId: 80094,
        urls: {
          apiURL: 'https://api.berascan.com/api',
          browserURL: 'https://berascan.com/',
        },
      },
      {
        network: 'cArtio',
        chainId: 80000,
        urls: {
          apiURL:
            'https://api.routescan.io/v2/network/testnet/evm/80000/etherscan/api',
          browserURL: 'https://80000.testnet.routescan.io/',
        },
      },
      {
        network: 'xchain',
        chainId: 94524,
        urls: {
          apiURL: 'https://xchain-explorer.kuma.bid/api/v1',
          browserURL: 'https://xchain-explorer.kuma.bid/',
        },
      },
      {
        network: 'xchainTestnet',
        chainId: 64002,
        urls: {
          apiURL: 'https://xchain-testnet-explorer.kuma.bid/api/v1',
          browserURL: 'https://xchain-testnet-explorer.kuma.bid/',
        },
      },
      {
        network: 'sepolia',
        chainId: 11155111,
        urls: {
          apiURL: 'https://api-sepolia.etherscan.io/api',
          browserURL: 'https://sepolia.etherscan.io/',
        },
      },
    ],
  },
};

export default config;
