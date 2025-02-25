// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { Constants } from "./Constants.sol";
import { Funding } from "./Funding.sol";
import { Hashing } from "./Hashing.sol";
import { MarketHelper } from "./MarketHelper.sol";
import { String } from "./String.sol";
import { Time } from "./Time.sol";
import { Validations } from "./Validations.sol";
import { IExchange, IIndexPriceAdapter, IOraclePriceAdapter } from "./Interfaces.sol";
import { IndexPricePayload, FundingMultiplierQuartet, IndexPrice, Market } from "./Structs.sol";

library MarketAdmin {
  using MarketHelper for Market;

  /**
   * @notice Emitted when the Dispatch Wallet activates a previously added market with `activateMarket`
   */
  event MarketActivated(string baseAssetSymbol);
  /**
   * @notice Emitted when admin adds a new market with `addMarket`
   */
  event MarketAdded(string baseAssetSymbol);
  /**
   * @notice Emitted when the Dispatch Wallet activates a previously activated market with `activateMarket`
   */
  event MarketDeactivated(string baseAssetSymbol);
  /**
   * @notice Emitted when the Dispatcher Wallet publishes a new index price with `publishIndexPrices`
   */
  event IndexPricePublished(string baseAssetSymbol, uint64 timestampInMs, uint64 price);

  // solhint-disable-next-line func-name-mixedcase
  function addMarket_delegatecall(
    Market memory newMarket,
    IExchange balanceMigrationSource,
    IOraclePriceAdapter oraclePriceAdapter,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    string[] storage marketBaseAssetSymbols,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) public {
    require(marketBaseAssetSymbols.length < Constants.MAX_NUMBER_OF_MARKETS, "Max number of markets reached");
    require(!marketsByBaseAssetSymbol[newMarket.baseAssetSymbol].exists, "Market already exists");
    require(
      !String.isEqual(newMarket.baseAssetSymbol, Constants.QUOTE_ASSET_SYMBOL),
      "Base asset symbol cannot be same as quote"
    );
    Validations.validateOverridableMarketFields(newMarket.overridableFields);

    // Populate non-overridable fields and commit new market to storage
    newMarket.exists = true;
    newMarket.isActive = isMarketActiveInMigrationSource(newMarket.baseAssetSymbol, balanceMigrationSource);
    newMarket.lastIndexPrice = oraclePriceAdapter.loadPriceForBaseAssetSymbol(newMarket.baseAssetSymbol);
    newMarket.lastIndexPriceTimestampInMs = uint64(block.timestamp * 1000);

    marketsByBaseAssetSymbol[newMarket.baseAssetSymbol] = newMarket;
    marketBaseAssetSymbols.push(newMarket.baseAssetSymbol);

    Funding.backfillFundingMultipliersForMarket(
      newMarket,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol
    );

    emit MarketAdded(newMarket.baseAssetSymbol);
  }

  // solhint-disable-next-line func-name-mixedcase
  function activateMarket_delegatecall(
    string calldata baseAssetSymbol,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) public {
    Market storage market = marketsByBaseAssetSymbol[baseAssetSymbol];
    require(market.exists && !market.isActive, "No inactive market found");

    market.isActive = true;
    market.indexPriceAtDeactivation = 0;

    emit MarketActivated(baseAssetSymbol);
  }

  // solhint-disable-next-line func-name-mixedcase
  function deactivateMarket_delegatecall(
    string calldata baseAssetSymbol,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) public {
    Market storage market = marketsByBaseAssetSymbol[baseAssetSymbol];
    require(market.exists && market.isActive, "No active market found");

    market.isActive = false;
    market.indexPriceAtDeactivation = market.lastIndexPrice;

    emit MarketDeactivated(baseAssetSymbol);
  }

  // solhint-disable-next-line func-name-mixedcase
  function publishIndexPrices_delegatecall(
    IndexPricePayload[] memory encodedIndexPrices,
    IIndexPriceAdapter[] memory indexPriceAdapters,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) public {
    Market storage market;
    IndexPrice memory indexPrice;

    for (uint8 i = 0; i < encodedIndexPrices.length; i++) {
      bool indexPriceAdapterIsWhitelisted = false;
      for (uint8 j = 0; j < indexPriceAdapters.length; j++) {
        if (encodedIndexPrices[i].indexPriceAdapter == address(indexPriceAdapters[j])) {
          indexPriceAdapterIsWhitelisted = true;
          break;
        }
      }
      require(indexPriceAdapterIsWhitelisted, "Invalid index price adapter");

      indexPrice = IIndexPriceAdapter(encodedIndexPrices[i].indexPriceAdapter).validateIndexPricePayload(
        encodedIndexPrices[i].payload
      );
      require(indexPrice.timestampInMs < Time.getOneDayFromNowInMs(), "Index price timestamp too high");

      market = marketsByBaseAssetSymbol[indexPrice.baseAssetSymbol];
      require(market.exists && market.isActive, "Active market not found");
      require(market.lastIndexPriceTimestampInMs < indexPrice.timestampInMs, "Outdated index price");

      market.lastIndexPrice = indexPrice.price;
      market.lastIndexPriceTimestampInMs = indexPrice.timestampInMs;

      emit IndexPricePublished(indexPrice.baseAssetSymbol, indexPrice.timestampInMs, indexPrice.price);
    }
  }

  function isMarketActiveInMigrationSource(
    string memory baseAssetSymbol,
    IExchange balanceMigrationSource
  ) private view returns (bool) {
    if (address(balanceMigrationSource) == address(0x0)) {
      return false;
    }

    uint256 marketsLength = balanceMigrationSource.loadMarketsLength();
    for (uint256 i = 0; i < marketsLength; i++) {
      Market memory migratedMarket = balanceMigrationSource.loadMarket(SafeCast.toUint8(i));
      if (String.isEqual(migratedMarket.baseAssetSymbol, baseAssetSymbol)) {
        return migratedMarket.isActive;
      }
    }

    return false;
  }
}
