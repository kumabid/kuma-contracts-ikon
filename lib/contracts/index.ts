import fs from 'fs';
import path from 'path';

import { ethers } from 'ethers';

import ChainlinkAggregator from './ChainlinkAggregator';
import CustodianContract from './CustodianContract';
import EarningsEscrowContract from './EarningsEscrow';
import ExchangeContract from './ExchangeContract';
import ExchangeLayerZeroAdapterContract from './ExchangeLayerZeroAdapterContract';
import ExchangeLayerZeroAdapterV2Contract from './ExchangeLayerZeroAdapterV2Contract';
import ExchangeWalletStateAggregatorContract from './ExchangeWalletStateAggregatorContract';
import GovernanceContract from './GovernanceContract';
import KumaIndexAndOraclePriceAdapterContract from './KumaIndexAndOraclePriceAdapterContract';
import PythIndexPriceAdapterContract from './PythIndexPriceAdapterContract';
import PythOraclePriceAdapterContract from './PythOraclePriceAdapterContract';
import StorkIndexAndOraclePriceAdapterContract from './StorkIndexAndOraclePriceAdapterContract';
import USDCContract from './USDCContract';
import { initRpcApi, loadProvider } from './utils';

export {
  initRpcApi,
  loadProvider,
  ChainlinkAggregator,
  CustodianContract,
  EarningsEscrowContract,
  ExchangeContract,
  ExchangeLayerZeroAdapterContract,
  ExchangeLayerZeroAdapterV2Contract,
  ExchangeWalletStateAggregatorContract,
  GovernanceContract,
  KumaIndexAndOraclePriceAdapterContract,
  PythIndexPriceAdapterContract,
  PythOraclePriceAdapterContract,
  StorkIndexAndOraclePriceAdapterContract,
  USDCContract,
};

export type LibraryName =
  | 'ClosureDeleveraging'
  | 'Depositing'
  | 'Funding'
  | 'IndexPriceMargin'
  | 'MarketAdmin'
  | 'NonceInvalidations'
  | 'OraclePriceMargin'
  | 'PositionBelowMinimumLiquidation'
  | 'PositionInDeactivatedMarketLiquidation'
  | 'Trading'
  | 'Transferring'
  | 'WalletExitAcquisitionDeleveraging'
  | 'WalletExitLiquidation'
  | 'WalletInMaintenanceAcquisitionDeleveraging'
  | 'WalletInMaintenanceLiquidation'
  | 'Withdrawing';

export async function deployLibrary(
  name: LibraryName,
  ownerWalletPrivateKey: string,
): Promise<string> {
  const bytecode = loadLibraryBytecode(name);
  const owner = new ethers.Wallet(ownerWalletPrivateKey, loadProvider());
  const library = await new ethers.ContractFactory(
    [],
    bytecode,
    owner,
  ).deploy();

  return (await library.waitForDeployment()).getAddress();
}

const libraryNameToBytecodeMap = new Map<LibraryName, string>();

function loadLibraryBytecode(name: LibraryName): string {
  if (!libraryNameToBytecodeMap.has(name)) {
    const { bytecode } = JSON.parse(
      fs
        .readFileSync(
          path.join(
            __dirname,
            '..',
            '..',
            '..',
            'artifacts',
            'contracts',
            'libraries',
            `${name}.sol`,
            `${name}.json`,
          ),
        )
        .toString('utf8'),
    );
    libraryNameToBytecodeMap.set(name, bytecode);
  }
  return libraryNameToBytecodeMap.get(name) as string; // Will never be undefined as it gets set above
}
