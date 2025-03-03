// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import { Balance, IndexPrice, Market, OverridableMarketFields } from "./Structs.sol";

/*
 * @notice Interface to Asset Migrator contract used by Custodian to migrate funds from one ERC-20 contract to another
 */
interface IAssetMigrator {
  /**
   * @notice Migrate an asset quantity to a new address
   *
   * @param sourceAsset The address of the old asset that will be migrated from
   * @param quantityInAssetUnits The quantity of token to transfer in asset units
   */
  function migrate(address sourceAsset, uint256 quantityInAssetUnits) external;

  /**
   * @notice Load the address of the destination asset that will be migrated to
   *
   * @return destinationAsset The address of the new asset that will migrated to
   */
  function destinationAsset() external returns (address);
}

/**
 * @notice Interface to Bridge Adapter contracts used by Exchange for routing withdrawals
 */
interface IBridgeAdapter {
  /**
   * @notice Withdraw quote asset quantity to destination wallet using bridge-specific payload
   */
  function withdrawQuoteAsset(address destinationWallet, uint256 quantity, bytes memory payload) external;
}

/**
 * @notice Interface to Custodian contract. Used by Exchange and Governance contracts for internal
 * calls
 */
interface ICustodian {
  /**
   * @notice Migrate the entire balance of an asset to a new address using the currently whitelisted Asset Migrator
   *
   * @param sourceAsset The address of the asset the Custodian currently holds a balance in
   *
   * @return destinationAsset The address of the new asset that will migrated to
   */
  function migrateAsset(address sourceAsset) external returns (address destinationAsset);

  /**
   * @notice Withdraw any asset and amount to a target wallet
   *
   * @dev No balance checking performed
   *
   * @param wallet The wallet to which assets will be returned
   * @param asset The address of the asset to withdraw (ERC-20 contract)
   * @param quantityInAssetUnits The quantity in asset units to withdraw
   */
  function withdraw(address wallet, address asset, uint256 quantityInAssetUnits) external;

  /**
   * @notice Load address of the currently whitelisted Exchange contract
   *
   * @return The address of the currently whitelisted Exchange contract
   */
  function exchange() external view returns (address);

  /**
   * @notice Sets a new Asset Migrator contract address
   *
   * @param newAssetMigrator The address of the new whitelisted Asset Migrator contract or zero address to disable migration
   */
  function setAssetMigrator(address newAssetMigrator) external;

  /**
   * @notice Sets a new Exchange contract address
   *
   * @param newExchange The address of the new whitelisted Exchange contract
   */
  function setExchange(address newExchange) external;

  /**
   * @notice Load address of the currently whitelisted Asset Migrator contract
   *
   * @return The address of the currently whitelisted Asset Migrator contract
   */
  function assetMigrator() external view returns (address);

  /**
   * @notice Load address of the currently whitelisted Governance contract
   *
   * @return The address of the currently whitelisted Governance contract
   */
  function governance() external view returns (address);

  /**
   * @notice Sets a new Governance contract address
   *
   * @param newGovernance The address of the new whitelisted Governance contract
   */
  function setGovernance(address newGovernance) external;
}

/**
 * @notice Interface to Exchange contract
 */
interface IExchange {
  /**
   * @notice Load a wallet's balance by asset symbol, in pips
   *
   * @param wallet The wallet address to load the balance for. Can be different from `msg.sender`
   * @param assetSymbol The asset symbol to load the wallet's balance for
   *
   * @return balance The quantity denominated in pips of asset at `assetSymbol` currently in an open position or
   * quote balance by `wallet` if base or quote respectively. Result may be negative
   */
  function loadBalanceBySymbol(address wallet, string calldata assetSymbol) external view returns (int64);

  /**
   * @notice Load a wallet's balance-tracking struct by asset symbol
   *
   * @param wallet The wallet address to load the balance for. Can be different from `msg.sender`
   * @param assetSymbol The asset symbol to load the wallet's balance for
   *
   * @return The internal `Balance` struct tracking the asset at `assetSymbol` currently in an open position for or
   * deposited by `wallet`
   */
  function loadBalanceStructBySymbol(
    address wallet,
    string calldata assetSymbol
  ) external view returns (Balance memory);

  /**
   * @notice Loads a list of all currently open positions for a wallet
   *
   * @param wallet The wallet address to load open positions for for. Can be different from `msg.sender`
   *
   * @return A list of base asset symbols corresponding to markets in which the wallet currently has an open position
   */
  function loadBaseAssetSymbolsWithOpenPositionsByWallet(address wallet) external view returns (string[] memory);

  /**
   * @notice Loads the total count of all markets added
   *
   * @return The total count of all markets added
   *
   */
  function loadMarketsLength() external view returns (uint256);

  /**
   * @notice Loads the Market at the given index by addition order
   *
   * @param index The index at which to load
   *
   * @return The Market at the given index by addition order
   */
  function loadMarket(uint8 index) external view returns (Market memory);

  /**
   * @notice Calculate total outstanding funding payments
   */
  function loadOutstandingWalletFunding(address wallet) external view returns (int64);

  /**
   * @notice Load the address of the Custodian contract
   *
   * @return The address of the Custodian contract
   */
  function custodian() external view returns (ICustodian);

  /**
   * @notice Deposit quote token
   *
   * @param quantityInAssetUnits The quantity to deposit. The sending wallet must first call the `approve` method on
   * the token contract for at least this quantity
   * @param destinationWallet The wallet which will be credited for the new balance. Defaults to sending wallet if zero
   */
  function deposit(uint256 quantityInAssetUnits, address destinationWallet) external;

  /**
   * @notice Load the number of deposits made to the contract, for use when upgrading to a new Exchange via Governance
   *
   * @return The number of deposits successfully made to the Exchange
   */
  function depositIndex() external view returns (uint64);

  /**
   * @notice Load the address of the currently whitelisted Dispatcher wallet
   *
   * @return The address of the Dispatcher wallet
   */
  function dispatcherWallet() external view returns (address);

  /**
   * @notice Load the address of the current Insurance Fund wallet
   *
   * @return The address of the Insurance Fund wallet
   */
  function insuranceFundWallet() external view returns (address);

  /**
   * @notice Sets bridge adapter contract addresses whitelisted for withdrawals
   *
   * @param newBridgeAdapters An array of bridge adapter contract addresses
   */
  function setBridgeAdapters(IBridgeAdapter[] memory newBridgeAdapters) external;

  /**
   * @notice Sets Index Price Adapter contract addresses
   *
   * @param newIndexPriceAdapters An array of contract addresses
   */
  function setIndexPriceAdapters(IIndexPriceAdapter[] memory newIndexPriceAdapters) external;

  /**
   * @notice Sets IF wallet address
   *
   * @param newInsuranceFundWallet The new IF wallet address
   */
  function setInsuranceFundWallet(address newInsuranceFundWallet) external;

  /**
   * @notice Set overridable market parameters for a specific wallet or as new market defaults
   *
   * @param baseAssetSymbol The base asset symbol for the market
   * @param overridableFields New values for overridable fields
   * @param wallet The wallet to apply overrides to. If zero, overrides apply to entire market
   */
  function setMarketOverrides(
    string memory baseAssetSymbol,
    OverridableMarketFields memory overridableFields,
    address wallet
  ) external;

  /**
   * @notice Sets Oracle Price Adapter contract address
   *
   * @param newOraclePriceAdapter The new contract addresses
   */
  function setOraclePriceAdapter(IOraclePriceAdapter newOraclePriceAdapter) external;
}

/**
 * @notice Interface to Index Price Adapter
 */
interface IIndexPriceAdapter {
  /**
   * @notice Validate encoded payload and return `IndexPrice` struct
   */
  function validateIndexPricePayload(bytes calldata payload) external returns (IndexPrice memory);

  /**
   * @notice Sets adapter as active, indicating that it is now whitelisted by the Exchange
   */
  function setActive(IExchange exchange) external;
}

/**
 * @notice Interface to Oracle Price Adapter
 */
interface IOraclePriceAdapter {
  /**
   * @notice Return latest price for base asset symbol in quote asset terms. Reverts if no price is available
   */
  function loadPriceForBaseAssetSymbol(string memory baseAssetSymbol) external view returns (uint64 price);

  /**
   * @notice Sets adapter as active, indicating that it is now whitelisted by the Exchange
   */
  function setActive(IExchange exchange) external;
}
