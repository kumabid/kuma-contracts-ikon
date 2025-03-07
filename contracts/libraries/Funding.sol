// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import { BalanceTracking } from "./BalanceTracking.sol";
import { Constants } from "./Constants.sol";
import { FundingMultiplierQuartetHelper } from "./FundingMultiplierQuartetHelper.sol";
import { Math } from "./Math.sol";
import { SortedStringSet } from "./SortedStringSet.sol";
import { Time } from "./Time.sol";
import { Balance, FundingMultiplierQuartet, Market } from "./Structs.sol";

library Funding {
  using BalanceTracking for BalanceTracking.Storage;
  using FundingMultiplierQuartetHelper for FundingMultiplierQuartet[];
  using SortedStringSet for string[];

  // solhint-disable-next-line func-name-mixedcase
  function applyOutstandingWalletFundingForMarket_delegatecall(
    string memory baseAssetSymbol,
    address wallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) public {
    Market memory market = marketsByBaseAssetSymbol[baseAssetSymbol];
    require(market.exists, "Market not found");
    require(
      baseAssetSymbolsWithOpenPositionsByWallet[wallet].indexOf(market.baseAssetSymbol) != SortedStringSet.NOT_FOUND,
      "No open position in market"
    );

    Balance storage basePosition = balanceTracking.loadBalanceStructAndMigrateIfNeeded(wallet, market.baseAssetSymbol);
    (int64 funding, uint64 toTimestampInMs) = _loadWalletFundingForMarket(
      basePosition,
      true,
      market,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol
    );
    basePosition.lastUpdateTimestampInMs = toTimestampInMs;

    Balance storage quoteBalance = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
      wallet,
      Constants.QUOTE_ASSET_SYMBOL
    );
    quoteBalance.balance += funding;
  }

  // solhint-disable-next-line func-name-mixedcase
  function loadOutstandingWalletFunding_delegatecall(
    address wallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) public view returns (int64 funding) {
    return
      loadOutstandingWalletFunding(
        wallet,
        balanceTracking,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        marketsByBaseAssetSymbol
      );
  }

  // solhint-disable-next-line func-name-mixedcase
  function publishFundingMultiplier_delegatecall(
    string memory baseAssetSymbol,
    int64 fundingRate,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) public {
    Market memory market = marketsByBaseAssetSymbol[baseAssetSymbol];
    require(market.exists && market.isActive, "No active market found");

    require(
      Math.abs(fundingRate) < market.overridableFields.maintenanceMarginFraction,
      "Funding rate exceeds maintenance margin fraction"
    );

    // The last publish timestamp will always be non-zero as set during market creation by `backfillFundingMultipliersForMarket`
    uint64 lastPublishTimestampInMs = lastFundingRatePublishTimestampInMsByBaseAssetSymbol[baseAssetSymbol];
    // Previous funding rate exists, next publish timestamp is exactly one period length from previous period start
    uint64 nextPublishTimestampInMs = lastPublishTimestampInMs + Constants.FUNDING_PERIOD_IN_MS;

    // Use the timestamp of the last index price for the market to determine if any funding periods were skipped
    if (market.lastIndexPriceTimestampInMs < nextPublishTimestampInMs) {
      // No missing periods, validate index price is not stale for next period
      require(
        nextPublishTimestampInMs - market.lastIndexPriceTimestampInMs < Constants.FUNDING_PERIOD_IN_MS / 2,
        "Index price too far before next period"
      );
    } else if (market.lastIndexPriceTimestampInMs > nextPublishTimestampInMs + Constants.FUNDING_PERIOD_IN_MS / 2) {
      // Backfill missing periods with a multiplier of 0 (no funding payments made)
      uint64 periodsToBackfill = Math.divideRoundNearest(
        market.lastIndexPriceTimestampInMs - nextPublishTimestampInMs,
        Constants.FUNDING_PERIOD_IN_MS
      );
      for (uint64 i = 0; i < periodsToBackfill; i++) {
        fundingMultipliersByBaseAssetSymbol[baseAssetSymbol].publishFundingMultiplier(0);
      }
      nextPublishTimestampInMs += periodsToBackfill * Constants.FUNDING_PERIOD_IN_MS;
    }

    int64 newFundingMultiplier = Math.multiplyPipsByFraction(
      Math.toInt64(market.lastIndexPrice),
      // The funding rate is positive when longs pay shorts, and negative when shorts pay longs. Flipping the sign
      // on the stored multiplier allows it to be directly multiplied by a wallet's position size to determine its
      // funding credit or debit
      -1 * fundingRate,
      Math.toInt64(Constants.PIP_PRICE_MULTIPLIER)
    );

    fundingMultipliersByBaseAssetSymbol[baseAssetSymbol].publishFundingMultiplier(newFundingMultiplier);

    lastFundingRatePublishTimestampInMsByBaseAssetSymbol[baseAssetSymbol] = nextPublishTimestampInMs;
  }

  function applyOutstandingWalletFunding(
    address wallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) internal {
    int64 funding;
    int64 marketFunding;
    uint64 lastFundingMultiplierTimestampInMs;

    string[] memory baseAssetSymbols = baseAssetSymbolsWithOpenPositionsByWallet[wallet];
    for (uint8 i = 0; i < baseAssetSymbols.length; i++) {
      Market memory market = marketsByBaseAssetSymbol[baseAssetSymbols[i]];
      Balance storage basePosition = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
        wallet,
        market.baseAssetSymbol
      );

      (marketFunding, lastFundingMultiplierTimestampInMs) = _loadWalletFundingForMarket(
        basePosition,
        false,
        market,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol
      );
      funding += marketFunding;
      basePosition.lastUpdateTimestampInMs = lastFundingMultiplierTimestampInMs;
    }

    Balance storage quoteBalance = balanceTracking.loadBalanceStructAndMigrateIfNeeded(
      wallet,
      Constants.QUOTE_ASSET_SYMBOL
    );
    quoteBalance.balance += funding;
  }

  function backfillFundingMultipliersForMarket(
    Market memory market,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol
  ) internal {
    // Always backfill 1 period for midnight, and an additional period for every period boundary crossed since then
    uint64 periodsToBackfill = 1 + (Time.getMsSinceMidnight() / Constants.FUNDING_PERIOD_IN_MS);
    for (uint64 i = 0; i < periodsToBackfill; i++) {
      fundingMultipliersByBaseAssetSymbol[market.baseAssetSymbol].publishFundingMultiplier(0);
    }

    lastFundingRatePublishTimestampInMsByBaseAssetSymbol[market.baseAssetSymbol] =
      Time.getMidnightTodayInMs() +
      // Midnight today is always the first period to be backfilled
      ((periodsToBackfill - 1) * Constants.FUNDING_PERIOD_IN_MS);
  }

  function loadOutstandingWalletFunding(
    address wallet,
    BalanceTracking.Storage storage balanceTracking,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => Market) storage marketsByBaseAssetSymbol
  ) internal view returns (int64 funding) {
    int64 marketFunding;

    BalanceTracking.TrackingForWallet storage balanceTrackingForWallet = balanceTracking.trackingByWallet[wallet];

    string[] memory baseAssetSymbols = (balanceTrackingForWallet.isMigrated ||
      balanceTracking.migrationSource == address(0x0))
      ? balanceTrackingForWallet.baseAssetSymbolsWithOpenPositions
      : balanceTracking.migrationSource.loadBaseAssetSymbolsWithOpenPositionsByWallet(wallet);
    for (uint8 i = 0; i < baseAssetSymbols.length; i++) {
      Market memory market = marketsByBaseAssetSymbol[baseAssetSymbols[i]];
      Balance memory basePosition = balanceTracking.loadBalanceStructFromMigrationSourceIfNeeded(
        wallet,
        market.baseAssetSymbol
      );

      (marketFunding, ) = _loadWalletFundingForMarket(
        basePosition,
        false,
        market,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol
      );
      funding += marketFunding;
    }
  }

  function _loadWalletFundingForMarket(
    Balance memory basePosition,
    bool limitMaxTimePeriod,
    Market memory market,
    mapping(string => FundingMultiplierQuartet[]) storage fundingMultipliersByBaseAssetSymbol,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol
  ) private view returns (int64, uint64) {
    // Load funding rates and index
    uint64 lastFundingRatePublishTimestampInMs = lastFundingRatePublishTimestampInMsByBaseAssetSymbol[
      market.baseAssetSymbol
    ];

    // Apply funding payments if new multipliers were published since the position was last updated
    if (basePosition.balance != 0 && basePosition.lastUpdateTimestampInMs < lastFundingRatePublishTimestampInMs) {
      // To calculate the number of multipliers to apply, start from the first funding multiplier following the last
      // position update and go up to the last published multiplier. Update timestamps are always period-aligned
      uint64 fromTimestampInMs = basePosition.lastUpdateTimestampInMs + Constants.FUNDING_PERIOD_IN_MS;

      uint64 toTimestampInMs;
      if (limitMaxTimePeriod) {
        // Limit number of multipliers applied if needed
        toTimestampInMs = Math.min(
          fromTimestampInMs + Constants.MAX_FUNDING_TIME_PERIOD_PER_UPDATE_IN_MS,
          lastFundingRatePublishTimestampInMs
        );
      } else {
        toTimestampInMs = lastFundingRatePublishTimestampInMs;
      }
      // There is no possibility of `fromTimestampInMs` being greater than `toTimestampInMs` - the maximum value
      // `fromTimestampInMs` can be initialized to is `lastFundingRatePublishTimestampInMs`, and `toTimestampInMs`
      // is either itself `lastFundingRatePublishTimestampInMs` OR `fromTimestampInMs` is at least
      // `MAX_FUNDING_TIME_PERIOD_PER_UPDATE_IN_MS` behind `lastFundingRatePublishTimestampInMs`

      // Load aggregate funding payment over specified from and to timestamps
      int64 funding = fundingMultipliersByBaseAssetSymbol[market.baseAssetSymbol].loadAggregatePayment(
        fromTimestampInMs,
        toTimestampInMs,
        lastFundingRatePublishTimestampInMs,
        basePosition.balance
      );

      return (funding, toTimestampInMs);
    }

    return (0, basePosition.lastUpdateTimestampInMs);
  }
}
