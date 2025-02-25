// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import { Constants } from "./Constants.sol";
import { LiquidationValidations } from "./LiquidationValidations.sol";
import { MarketHelper } from "./MarketHelper.sol";
import { Math } from "./Math.sol";
import { OrderSide } from "./Enums.sol";
import { SortedStringSet } from "./SortedStringSet.sol";
import { String } from "./String.sol";
import { IExchange, IOraclePriceAdapter } from "./Interfaces.sol";
import { Balance, ExecuteTradeArguments, Market, MarketOverrides, Transfer, Withdrawal } from "./Structs.sol";

library BalanceTracking {
  using MarketHelper for Market;
  using SortedStringSet for string[];

  struct Storage {
    mapping(address => mapping(string => Balance)) balancesByWalletAssetPair;
    // Predecessor Exchange contract from which to lazily migrate balances
    IExchange migrationSource;
  }

  struct UpdatePositionForExitArguments {
    int64 exitAccountValue;
    address exitFundWallet;
    uint64 maintenanceMarginFraction;
    Market market;
    IOraclePriceAdapter oraclePriceAdapter;
    int256 totalAccountValueInDoublePips;
    uint256 totalMaintenanceMarginRequirementInTriplePips;
    address wallet;
  }

  // Depositing //

  function updateForDeposit(Storage storage self, address wallet, uint64 quantity) internal returns (int64 newBalance) {
    Balance storage balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, wallet, Constants.QUOTE_ASSET_SYMBOL);
    balanceStruct.balance += Math.toInt64(quantity);

    return balanceStruct.balance;
  }

  // Liquidation //

  function updatePositionsForDeleverage(
    Storage storage self,
    uint64 baseQuantity,
    address counterpartyWallet,
    address exitFundWallet,
    address liquidatingWallet,
    Market memory market,
    uint64 quoteQuantity,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet
  ) internal {
    _updatePositionsForDeleverageOrLiquidation(
      self,
      baseQuantity,
      counterpartyWallet,
      exitFundWallet,
      true,
      liquidatingWallet,
      market,
      quoteQuantity,
      baseAssetSymbolsWithOpenPositionsByWallet,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet
    );
  }

  function updatePositionsForLiquidation(
    Storage storage self,
    address counterpartyWallet,
    address exitFundWallet,
    address liquidatingWallet,
    Market memory market,
    int64 positionSize,
    uint64 quoteQuantity,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet
  ) internal {
    _updatePositionsForDeleverageOrLiquidation(
      self,
      Math.abs(positionSize),
      counterpartyWallet,
      exitFundWallet,
      false,
      liquidatingWallet,
      market,
      quoteQuantity,
      baseAssetSymbolsWithOpenPositionsByWallet,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet
    );
  }

  function updatePositionForDeactivatedMarketLiquidation(
    Storage storage self,
    string memory baseAssetSymbol,
    uint64 feeQuantity,
    address feeWallet,
    address liquidatingWallet,
    uint64 quoteQuantity,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet
  ) internal {
    Balance storage balanceStruct;

    // Zero out wallet position for market
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, liquidatingWallet, baseAssetSymbol);
    bool isLiquidatingWalletPositionShort = balanceStruct.balance < 0;
    _resetPositionToZero(balanceStruct);

    _updateOpenPositionTrackingForWallet(
      liquidatingWallet,
      baseAssetSymbol,
      balanceStruct.balance,
      baseAssetSymbolsWithOpenPositionsByWallet
    );

    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, liquidatingWallet, Constants.QUOTE_ASSET_SYMBOL);
    if (isLiquidatingWalletPositionShort) {
      // Wallet gives quote including fee if short
      balanceStruct.balance -= Math.toInt64(quoteQuantity + feeQuantity);
    } else {
      // Wallet receives quote minus fee if long
      balanceStruct.balance += Math.toInt64(quoteQuantity - feeQuantity);
    }

    // Fee wallet receives fee
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, feeWallet, Constants.QUOTE_ASSET_SYMBOL);
    balanceStruct.balance += Math.toInt64(feeQuantity);
  }

  function updateRemainingQuoteBalanceAfterWalletLiquidation(
    Storage storage self,
    address counterpartyWallet,
    address liquidatingWallet
  ) internal {
    Balance storage balanceStruct;

    // Liquidating wallet quote balance goes to zero
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, liquidatingWallet, Constants.QUOTE_ASSET_SYMBOL);
    int64 quoteQuantity = balanceStruct.balance;
    balanceStruct.balance = 0;
    // Counterparty wallet takes any remaining quote from liquidating wallet
    if (quoteQuantity != 0) {
      balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, counterpartyWallet, Constants.QUOTE_ASSET_SYMBOL);
      balanceStruct.balance += quoteQuantity;
    }
  }

  // Wallet exits //

  function updateExitFundWalletForExit(
    Storage storage self,
    address exitFundWallet
  ) internal returns (int64 walletQuoteQuantityToWithdraw) {
    Balance storage balanceStruct = loadBalanceStructAndMigrateIfNeeded(
      self,
      exitFundWallet,
      Constants.QUOTE_ASSET_SYMBOL
    );

    walletQuoteQuantityToWithdraw = balanceStruct.balance;
    balanceStruct.balance = 0;
  }

  /**
   * @return The signed change to the EF's quote balance as a result of closing the position. This will be positive for
   * a short position and negative for a long position. This function does not update the EF's quote balance itself;
   * that is left to the calling function so that it can perform a single update with the sum of each position's result
   */
  function updatePositionForExit(
    Storage storage self,
    UpdatePositionForExitArguments memory arguments,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol
  ) internal returns (int64) {
    Balance storage balanceStruct = loadBalanceStructAndMigrateIfNeeded(
      self,
      arguments.wallet,
      arguments.market.baseAssetSymbol
    );
    uint64 oraclePrice = arguments.oraclePriceAdapter.loadPriceForBaseAssetSymbol(arguments.market.baseAssetSymbol);
    int64 positionSize = balanceStruct.balance;
    // Calculate amount of quote to close position
    uint64 quoteQuantity = arguments.exitAccountValue <= 0
      ? LiquidationValidations.calculateQuoteQuantityAtBankruptcyPrice(
        // This exit path takes place entirely on-chain, so use on-chain oracle pricing rather than index pricing
        oraclePrice,
        arguments.maintenanceMarginFraction,
        positionSize,
        arguments.totalAccountValueInDoublePips,
        arguments.totalMaintenanceMarginRequirementInTriplePips
      )
      : LiquidationValidations.calculateQuoteQuantityAtExitPrice(balanceStruct.costBasis, oraclePrice, positionSize);

    // Zero out wallet position for market
    _resetPositionToZero(balanceStruct);
    _updateOpenPositionTrackingForWallet(
      arguments.wallet,
      arguments.market.baseAssetSymbol,
      balanceStruct.balance,
      baseAssetSymbolsWithOpenPositionsByWallet
    );

    // Exit Fund wallet takes on wallet's position
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(
      self,
      arguments.exitFundWallet,
      arguments.market.baseAssetSymbol
    );

    if (positionSize < 0) {
      // Take on short position by subtracting base quantity
      _subtractFromPosition(
        arguments.market.baseAssetSymbol,
        Math.abs(positionSize),
        quoteQuantity,
        // EF can assume arbitrary position sizes
        Constants.MAX_MAXIMUM_POSITION_SIZE,
        balanceStruct,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol
      );
    } else {
      // Take on long position by adding base quantity
      _addToPosition(
        arguments.market.baseAssetSymbol,
        Math.abs(positionSize),
        quoteQuantity,
        // EF can assume arbitrary position sizes
        Constants.MAX_MAXIMUM_POSITION_SIZE,
        balanceStruct,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol
      );
    }
    // Update open position tracking for EF in case the position was opened or closed
    _updateOpenPositionTrackingForWallet(
      arguments.exitFundWallet,
      arguments.market.baseAssetSymbol,
      balanceStruct.balance,
      baseAssetSymbolsWithOpenPositionsByWallet
    );

    // Return the change to the EF's quote balance needed to acquire the position. For short positions, the EF
    // receives quote so returns a positive value. For long positions, the EF gives quote and returns a negative value
    return positionSize < 0 ? Math.toInt64(quoteQuantity) : -1 * Math.toInt64(quoteQuantity);

    // The Exit Fund quote balance is not updated here, but instead is updated a single time in the calling function
    // after summing the quote quantities needed to close each wallet position
  }

  // Trading //

  /**
   * @dev Updates buyer, seller, and fee wallet balances for both assets in trade pair according to
   * trade parameters
   */
  function updateForTrade(
    Storage storage self,
    ExecuteTradeArguments memory arguments,
    address feeWallet,
    Market memory market,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet
  ) internal returns (bool wasBuyPositionReduced, bool wasSellPositionReduced) {
    Balance storage balanceStruct;

    (int64 buyFee, int64 sellFee) = arguments.trade.makerSide == OrderSide.Buy
      ? (arguments.trade.makerFeeQuantity, Math.toInt64(arguments.trade.takerFeeQuantity))
      : (Math.toInt64(arguments.trade.takerFeeQuantity), arguments.trade.makerFeeQuantity);

    // Seller gives base asset
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, arguments.sell.wallet, arguments.trade.baseAssetSymbol);
    if (arguments.sell.isReduceOnly) {
      _validatePositionUpdatedTowardsZero(
        balanceStruct.balance,
        balanceStruct.balance - Math.toInt64(arguments.trade.baseQuantity)
      );
    }
    wasSellPositionReduced = _subtractFromPosition(
      market.baseAssetSymbol,
      arguments.trade.baseQuantity,
      arguments.trade.quoteQuantity,
      market
        .loadMarketWithOverridesForWallet(arguments.sell.wallet, marketOverridesByBaseAssetSymbolAndWallet)
        .overridableFields
        .maximumPositionSize,
      balanceStruct,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol
    );
    _updateOpenPositionTrackingForWallet(
      arguments.sell.wallet,
      arguments.trade.baseAssetSymbol,
      balanceStruct.balance,
      baseAssetSymbolsWithOpenPositionsByWallet
    );

    // Buyer receives base asset
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, arguments.buy.wallet, arguments.trade.baseAssetSymbol);
    if (arguments.buy.isReduceOnly) {
      _validatePositionUpdatedTowardsZero(
        balanceStruct.balance,
        balanceStruct.balance + Math.toInt64(arguments.trade.baseQuantity)
      );
    }
    wasBuyPositionReduced = _addToPosition(
      market.baseAssetSymbol,
      arguments.trade.baseQuantity,
      arguments.trade.quoteQuantity,
      market
        .loadMarketWithOverridesForWallet(arguments.buy.wallet, marketOverridesByBaseAssetSymbolAndWallet)
        .overridableFields
        .maximumPositionSize,
      balanceStruct,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol
    );
    _updateOpenPositionTrackingForWallet(
      arguments.buy.wallet,
      arguments.trade.baseAssetSymbol,
      balanceStruct.balance,
      baseAssetSymbolsWithOpenPositionsByWallet
    );

    // Buyer gives quote asset including fees
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, arguments.buy.wallet, Constants.QUOTE_ASSET_SYMBOL);
    balanceStruct.balance -= Math.toInt64(arguments.trade.quoteQuantity) + buyFee;

    // Seller receives quote asset minus fees
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, arguments.sell.wallet, Constants.QUOTE_ASSET_SYMBOL);
    balanceStruct.balance += Math.toInt64(arguments.trade.quoteQuantity) - sellFee;

    // Fee wallet receives maker and taker fees
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, feeWallet, Constants.QUOTE_ASSET_SYMBOL);
    balanceStruct.balance += buyFee + sellFee;
  }

  // Transferring //

  function updateForTransfer(
    Storage storage self,
    Transfer memory transfer,
    address feeWallet
  ) internal returns (int64 newDestinationWalletExchangeBalance, int64 newSourceWalletExchangeBalance) {
    Balance storage balanceStruct;

    // Remove quote amount from source wallet balance
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, transfer.sourceWallet, Constants.QUOTE_ASSET_SYMBOL);
    // The calling function will subsequently validate this balance change by checking initial margin requirement
    balanceStruct.balance -= Math.toInt64(transfer.grossQuantity);
    newSourceWalletExchangeBalance = balanceStruct.balance;

    // Send quote amount minus gas fee (if any) to destination wallet balance
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, transfer.destinationWallet, Constants.QUOTE_ASSET_SYMBOL);
    balanceStruct.balance += Math.toInt64(transfer.grossQuantity - transfer.gasFee);
    newDestinationWalletExchangeBalance = balanceStruct.balance;

    if (transfer.gasFee > 0) {
      balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, feeWallet, Constants.QUOTE_ASSET_SYMBOL);

      balanceStruct.balance += Math.toInt64(transfer.gasFee);
    }
  }

  // Withdrawing //

  function updateForWithdrawal(
    Storage storage self,
    Withdrawal memory withdrawal,
    address feeWallet
  ) internal returns (int64 newExchangeBalance) {
    Balance storage balanceStruct;

    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, withdrawal.wallet, Constants.QUOTE_ASSET_SYMBOL);
    // The calling function will subsequently validate this balance change by checking initial margin requirement
    balanceStruct.balance -= Math.toInt64(withdrawal.grossQuantity);
    newExchangeBalance = balanceStruct.balance;

    if (withdrawal.gasFee > 0) {
      balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, feeWallet, Constants.QUOTE_ASSET_SYMBOL);

      balanceStruct.balance += Math.toInt64(withdrawal.gasFee);
    }
  }

  // Accessors //

  function loadBalanceFromMigrationSourceIfNeeded(
    Storage storage self,
    address wallet,
    string memory assetSymbol
  ) internal view returns (int64) {
    return loadBalanceStructFromMigrationSourceIfNeeded(self, wallet, assetSymbol).balance;
  }

  function loadBalanceStructFromMigrationSourceIfNeeded(
    Storage storage self,
    address wallet,
    string memory assetSymbol
  ) internal view returns (Balance memory) {
    Balance memory balanceStruct = self.balancesByWalletAssetPair[wallet][assetSymbol];

    if (!balanceStruct.isMigrated && address(self.migrationSource) != address(0x0)) {
      balanceStruct = self.migrationSource.loadBalanceStructBySymbol(wallet, assetSymbol);
    }

    return balanceStruct;
  }

  // Lazy updates //

  function loadBalanceAndMigrateIfNeeded(
    Storage storage self,
    address wallet,
    string memory assetSymbol
  ) internal returns (int64) {
    return loadBalanceStructAndMigrateIfNeeded(self, wallet, assetSymbol).balance;
  }

  function loadBalanceStructAndMigrateIfNeeded(
    Storage storage self,
    address wallet,
    string memory assetSymbol
  ) internal returns (Balance storage) {
    Balance storage balance = self.balancesByWalletAssetPair[wallet][assetSymbol];

    Balance memory migratedBalanceStruct;
    if (!balance.isMigrated && address(self.migrationSource) != address(0x0)) {
      migratedBalanceStruct = self.migrationSource.loadBalanceStructBySymbol(wallet, assetSymbol);
      if (String.isEqual(assetSymbol, Constants.QUOTE_ASSET_SYMBOL)) {
        migratedBalanceStruct.balance += self.migrationSource.loadOutstandingWalletFunding(wallet);
      }

      balance.isMigrated = true;
      balance.balance = migratedBalanceStruct.balance;
      balance.lastUpdateTimestampInMs = migratedBalanceStruct.lastUpdateTimestampInMs;
      balance.costBasis = migratedBalanceStruct.costBasis;
    }

    return balance;
  }

  // Position updates //

  function _addToPosition(
    string memory baseAssetSymbol,
    uint64 baseQuantity,
    uint64 quoteQuantity,
    uint64 maximumPositionSize,
    Balance storage balanceStruct,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol
  ) private returns (bool wasPositionReduced) {
    int64 newBalance = balanceStruct.balance + Math.toInt64(baseQuantity);

    // Position closed
    if (newBalance == 0) {
      wasPositionReduced = balanceStruct.balance != 0;
      _resetPositionToZero(balanceStruct);
      return wasPositionReduced;
    }

    // Position opened (newBalance is non-zero per preceding guard)
    if (balanceStruct.balance == 0) {
      // Update newly-opened position with the latest published funding rate for that market so that no funding is
      // applied retroactively
      balanceStruct.lastUpdateTimestampInMs = lastFundingRatePublishTimestampInMsByBaseAssetSymbol[baseAssetSymbol];
    }

    wasPositionReduced = _validatePositionBelowMaximumOrReduced(balanceStruct.balance, newBalance, maximumPositionSize);

    if (balanceStruct.balance >= 0) {
      // Increase position
      balanceStruct.costBasis += Math.toInt64(quoteQuantity);
    } else if (newBalance > 0) {
      // Going from negative to positive. Only the portion of the quote qty that contributed to the new, positive
      // balance is its cost. Base quantity validated non-zero by calling function
      balanceStruct.costBasis = Math.multiplyPipsByFraction(
        Math.toInt64(quoteQuantity),
        newBalance,
        Math.toInt64(baseQuantity)
      );
    } else {
      // Reduce cost basis proportional to reduction of position
      balanceStruct.costBasis += Math.multiplyPipsByFraction(
        balanceStruct.costBasis,
        Math.toInt64(baseQuantity),
        balanceStruct.balance
      );
    }

    balanceStruct.balance = newBalance;
  }

  function _subtractFromPosition(
    string memory baseAssetSymbol,
    uint64 baseQuantity,
    uint64 quoteQuantity,
    uint64 maximumPositionSize,
    Balance storage balanceStruct,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol
  ) private returns (bool wasPositionReduced) {
    int64 newBalance = balanceStruct.balance - Math.toInt64(baseQuantity);

    // Position closed
    if (newBalance == 0) {
      wasPositionReduced = balanceStruct.balance != 0;
      _resetPositionToZero(balanceStruct);
      return wasPositionReduced;
    }

    // Position opened (newBalance is non-zero per preceding guard)
    if (balanceStruct.balance == 0) {
      // Update newly-opened position with the latest published funding rate for that market so that no funding is
      // applied retroactively
      balanceStruct.lastUpdateTimestampInMs = lastFundingRatePublishTimestampInMsByBaseAssetSymbol[baseAssetSymbol];
    }

    wasPositionReduced = _validatePositionBelowMaximumOrReduced(balanceStruct.balance, newBalance, maximumPositionSize);

    if (balanceStruct.balance <= 0) {
      // Increase position
      balanceStruct.costBasis -= Math.toInt64(quoteQuantity);
    } else if (newBalance < 0) {
      // Going from positive to negative. Only the portion of the quote qty that contributed to the new, positive balance
      // is its cost. Base quantity validated non-zero by calling function
      balanceStruct.costBasis = Math.multiplyPipsByFraction(
        Math.toInt64(quoteQuantity),
        newBalance,
        Math.toInt64(baseQuantity)
      );
    } else {
      // Reduce cost basis proportional to reduction of position
      balanceStruct.costBasis -= Math.multiplyPipsByFraction(
        balanceStruct.costBasis,
        Math.toInt64(baseQuantity),
        balanceStruct.balance
      );
    }

    balanceStruct.balance = newBalance;
  }

  function _resetPositionToZero(Balance storage balanceStruct) private {
    balanceStruct.balance = 0;
    balanceStruct.costBasis = 0;
    balanceStruct.lastUpdateTimestampInMs = 0;
  }

  function _updateCounterpartyPositionForDeleverageOrLiquidation(
    Storage storage self,
    uint64 baseQuantity,
    address counterpartyWallet,
    address exitFundWallet,
    bool isDeleverage,
    bool isLiquidatingWalletPositionShort,
    Market memory market,
    uint64 quoteQuantity,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet
  ) private {
    // Update counterparty wallet position by taking on liquidating wallet's position. During liquidation the IF or EF
    // position may validly increase by moving away from zero, but this is disallowed for the counterparty wallet
    // position during deleveraging
    Balance storage balanceStruct = loadBalanceStructAndMigrateIfNeeded(
      self,
      counterpartyWallet,
      market.baseAssetSymbol
    );
    // Counterparty wallet is EF for `WalletInMaintenanceDuringSystemRecovery` liquidations
    uint64 maximumPositionSize = counterpartyWallet == exitFundWallet
      ? Constants.MAX_MAXIMUM_POSITION_SIZE
      : market
        .loadMarketWithOverridesForWallet(counterpartyWallet, marketOverridesByBaseAssetSymbolAndWallet)
        .overridableFields
        .maximumPositionSize;

    if (isLiquidatingWalletPositionShort) {
      if (isDeleverage) {
        // Counterparty position must decrease during deleveraging
        _validatePositionUpdatedTowardsZero(balanceStruct.balance, balanceStruct.balance - Math.toInt64(baseQuantity));
      }

      // Take on short position by subtracting base quantity
      _subtractFromPosition(
        market.baseAssetSymbol,
        baseQuantity,
        quoteQuantity,
        maximumPositionSize,
        balanceStruct,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol
      );
    } else {
      if (isDeleverage) {
        // Counterparty position must decrease during deleveraging
        _validatePositionUpdatedTowardsZero(balanceStruct.balance, balanceStruct.balance + Math.toInt64(baseQuantity));
      }

      // Take on long position by adding base quantity
      _addToPosition(
        market.baseAssetSymbol,
        baseQuantity,
        quoteQuantity,
        maximumPositionSize,
        balanceStruct,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol
      );
    }

    // Update open position tracking in case it was just opened (if counterparty wallet is IF or EF only) or closed
    _updateOpenPositionTrackingForWallet(
      counterpartyWallet,
      market.baseAssetSymbol,
      balanceStruct.balance,
      baseAssetSymbolsWithOpenPositionsByWallet
    );

    // Update quote balance
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, counterpartyWallet, Constants.QUOTE_ASSET_SYMBOL);
    if (isLiquidatingWalletPositionShort) {
      // Counterparty receives quote when taking on short position
      balanceStruct.balance += Math.toInt64(quoteQuantity);
    } else {
      // Counterparty gives quote when taking on long position
      balanceStruct.balance -= Math.toInt64(quoteQuantity);
    }
  }

  function _updateLiquidatingPositionForDeleverageOrLiquidation(
    Storage storage self,
    uint64 baseQuantity,
    address exitFundWallet,
    address liquidatingWallet,
    Market memory market,
    uint64 quoteQuantity,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet
  ) private returns (bool isLiquidatingWalletPositionShort) {
    // Update liquidating wallet position by decreasing it towards zero
    Balance storage balanceStruct = loadBalanceStructAndMigrateIfNeeded(
      self,
      liquidatingWallet,
      market.baseAssetSymbol
    );
    isLiquidatingWalletPositionShort = balanceStruct.balance < 0;
    // Liquidating wallet is EF for ExitFundClosure deleverages
    uint64 maximumPositionSize = liquidatingWallet == exitFundWallet
      ? Constants.MAX_MAXIMUM_POSITION_SIZE
      : market
        .loadMarketWithOverridesForWallet(liquidatingWallet, marketOverridesByBaseAssetSymbolAndWallet)
        .overridableFields
        .maximumPositionSize;

    if (isLiquidatingWalletPositionShort) {
      // Reduce negative short position by adding base quantity to it
      _validatePositionUpdatedTowardsZero(balanceStruct.balance, balanceStruct.balance + Math.toInt64(baseQuantity));

      // Reduce short position by adding base quantity
      _addToPosition(
        market.baseAssetSymbol,
        baseQuantity,
        quoteQuantity,
        maximumPositionSize,
        balanceStruct,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol
      );
    } else {
      // Reduce positive long position by subtracting base quantity from it
      _validatePositionUpdatedTowardsZero(balanceStruct.balance, balanceStruct.balance - Math.toInt64(baseQuantity));

      // Reduce long position by subtracting base quantity
      _subtractFromPosition(
        market.baseAssetSymbol,
        baseQuantity,
        quoteQuantity,
        maximumPositionSize,
        balanceStruct,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol
      );
    }

    // Update open position tracking in case it was just closed
    _updateOpenPositionTrackingForWallet(
      liquidatingWallet,
      market.baseAssetSymbol,
      balanceStruct.balance,
      baseAssetSymbolsWithOpenPositionsByWallet
    );

    // Update quote balance
    balanceStruct = loadBalanceStructAndMigrateIfNeeded(self, liquidatingWallet, Constants.QUOTE_ASSET_SYMBOL);
    if (isLiquidatingWalletPositionShort) {
      // Liquidating wallet gives quote if short
      balanceStruct.balance -= Math.toInt64(quoteQuantity);
    } else {
      // Liquidating wallet receives quote if long
      balanceStruct.balance += Math.toInt64(quoteQuantity);
    }
  }

  function _updateOpenPositionTrackingForWallet(
    address wallet,
    string memory assetSymbol,
    int64 balance,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet
  ) private {
    baseAssetSymbolsWithOpenPositionsByWallet[wallet] = balance == 0
      ? baseAssetSymbolsWithOpenPositionsByWallet[wallet].remove(assetSymbol)
      : baseAssetSymbolsWithOpenPositionsByWallet[wallet].insertSorted(assetSymbol);
  }

  function _updatePositionsForDeleverageOrLiquidation(
    Storage storage self,
    uint64 baseQuantity,
    address counterpartyWallet,
    address exitFundWallet,
    bool isDeleverage,
    address liquidatingWallet,
    Market memory market,
    uint64 quoteQuantity,
    mapping(address => string[]) storage baseAssetSymbolsWithOpenPositionsByWallet,
    mapping(string => uint64) storage lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
    mapping(string => mapping(address => MarketOverrides)) storage marketOverridesByBaseAssetSymbolAndWallet
  ) private {
    bool isLiquidatingWalletPositionShort = _updateLiquidatingPositionForDeleverageOrLiquidation(
      self,
      baseQuantity,
      exitFundWallet,
      liquidatingWallet,
      market,
      quoteQuantity,
      baseAssetSymbolsWithOpenPositionsByWallet,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet
    );
    _updateCounterpartyPositionForDeleverageOrLiquidation(
      self,
      baseQuantity,
      counterpartyWallet,
      exitFundWallet,
      isDeleverage,
      isLiquidatingWalletPositionShort,
      market,
      quoteQuantity,
      baseAssetSymbolsWithOpenPositionsByWallet,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet
    );
  }

  function _validatePositionBelowMaximumOrReduced(
    int64 originalPositionSize,
    int64 newPositionSize,
    uint64 maximumPositionSize
  ) private pure returns (bool wasPositionReduced) {
    uint64 newPositionSizeUnsigned = Math.abs(newPositionSize);
    wasPositionReduced = newPositionSizeUnsigned < Math.abs(originalPositionSize);

    if (newPositionSizeUnsigned > maximumPositionSize) {
      require(wasPositionReduced, "Max position size exceeded");
    }
  }

  function _validatePositionUpdatedTowardsZero(int64 originalPositionSize, int64 newPositionSize) private pure {
    require(originalPositionSize != 0, "Position must be non-zero");

    bool isValidUpdate = originalPositionSize < 0
      ? newPositionSize > originalPositionSize && newPositionSize <= 0
      : newPositionSize < originalPositionSize && newPositionSize >= 0;
    require(isValidUpdate, "Position must move toward zero");
  }
}
