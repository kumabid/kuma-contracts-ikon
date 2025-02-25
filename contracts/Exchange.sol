// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import { AssetUnitConversions } from "./libraries/AssetUnitConversions.sol";
import { BalanceTracking } from "./libraries/BalanceTracking.sol";
import { ClosureDeleveraging } from "./libraries/ClosureDeleveraging.sol";
import { Constants } from "./libraries/Constants.sol";
import { Depositing } from "./libraries/Depositing.sol";
import { ExitFund } from "./libraries/ExitFund.sol";
import { Funding } from "./libraries/Funding.sol";
import { Hashing } from "./libraries/Hashing.sol";
import { IndexPriceMargin } from "./libraries/IndexPriceMargin.sol";
import { MarketAdmin } from "./libraries/MarketAdmin.sol";
import { Math } from "./libraries/Math.sol";
import { NonceInvalidations } from "./libraries/NonceInvalidations.sol";
import { OraclePriceMargin } from "./libraries/OraclePriceMargin.sol";
import { Owned } from "./Owned.sol";
import { PositionBelowMinimumLiquidation } from "./libraries/PositionBelowMinimumLiquidation.sol";
import { PositionInDeactivatedMarketLiquidation } from "./libraries/PositionInDeactivatedMarketLiquidation.sol";
import { String } from "./libraries/String.sol";
import { Trading } from "./libraries/Trading.sol";
import { Transferring } from "./libraries/Transferring.sol";
import { Validations } from "./libraries/Validations.sol";
import { WalletExitAcquisitionDeleveraging } from "./libraries/WalletExitAcquisitionDeleveraging.sol";
import { WalletExitLiquidation } from "./libraries/WalletExitLiquidation.sol";
import { WalletExits } from "./libraries/WalletExits.sol";
import { WalletInMaintenanceAcquisitionDeleveraging } from "./libraries/WalletInMaintenanceAcquisitionDeleveraging.sol";
import { WalletInMaintenanceLiquidation } from "./libraries/WalletInMaintenanceLiquidation.sol";
import { Withdrawing } from "./libraries/Withdrawing.sol";
import { AcquisitionDeleverageArguments, Balance, ClosureDeleverageArguments, ExecuteTradeArguments, FundingMultiplierQuartet, IndexPricePayload, Market, MarketOverrides, NonceInvalidation, Order, Trade, OverridableMarketFields, PositionBelowMinimumLiquidationArguments, PositionInDeactivatedMarketLiquidationArguments, Transfer, WalletExit, WalletLiquidationArguments, Withdrawal } from "./libraries/Structs.sol";
import { DeleverageType, LiquidationType, OrderSide } from "./libraries/Enums.sol";
import { IBridgeAdapter, ICustodian, IExchange, IIndexPriceAdapter, IOraclePriceAdapter } from "./libraries/Interfaces.sol";

// solhint-disable-next-line contract-name-camelcase
contract Exchange_v1 is EIP712, IExchange, Owned {
  using BalanceTracking for BalanceTracking.Storage;
  using NonceInvalidations for mapping(address => NonceInvalidation[]);

  // State variables //

  // Balance tracking
  BalanceTracking.Storage private _balanceTracking;
  // Mapping of wallet => list of base asset symbols with open positions
  mapping(address => string[]) public baseAssetSymbolsWithOpenPositionsByWallet;
  // Mapping of order wallet hash => isComplete
  mapping(bytes32 => bool) private _completedOrderHashes;
  // Transfers - mapping of transfer wallet hash => isComplete
  mapping(bytes32 => bool) private _completedTransferHashes;
  // Withdrawals - mapping of withdrawal wallet hash => isComplete
  mapping(bytes32 => bool) private _completedWithdrawalHashes;
  // List of whitelisted cross-chain Bridge Adapter contracts
  IBridgeAdapter[] public bridgeAdapters;
  // Fund custody contract
  ICustodian public custodian;
  // Deposit index
  uint64 public depositIndex;
  // Zero only if Exit Fund has no open positions or quote balance
  uint256 public exitFundPositionOpenedAtBlockTimestamp;
  // List of whitelisted Index Price Adapter contracts
  IIndexPriceAdapter[] public indexPriceAdapters;
  // Must be true or `deposit` will revert
  bool public isDepositEnabled;
  // If positive (index increases) longs pay shorts; if negative (index decreases) shorts pay longs
  mapping(string => FundingMultiplierQuartet[]) public fundingMultipliersByBaseAssetSymbol;
  // Milliseconds since epoch, always aligned to funding period
  mapping(string => uint64) public lastFundingRatePublishTimestampInMsByBaseAssetSymbol;
  // Wallet-specific market parameter overrides
  mapping(string => mapping(address => MarketOverrides)) public marketOverridesByBaseAssetSymbolAndWallet;
  // A list of base asset symbols for all markets in addition order
  string[] public marketBaseAssetSymbols;
  // Mapping of base asset symbol => market struct
  mapping(string => Market) private _marketsByBaseAssetSymbol;
  // Mapping of wallet => last invalidated timestamp in milliseconds
  mapping(address => NonceInvalidation[]) public nonceInvalidationsByWallet;
  // Currently whitelisted Oracle Price Adapter, used for on-chain exits
  IOraclePriceAdapter public oraclePriceAdapter;
  // Mapping of order hash => filled quantity in pips
  mapping(bytes32 => uint64) private _partiallyFilledOrderQuantities;
  // Mapping of wallet address to total pending deposit quantity
  mapping(address => uint64) public pendingDepositQuantityByWallet;
  // Address of ERC-20 contract used as collateral and quote for all markets
  address public quoteTokenAddress;
  // Exits
  mapping(address => WalletExit) public walletExits;

  // State variables - tunable parameters //

  uint256 public chainPropagationPeriodInS;
  uint64 public delegateKeyExpirationPeriodInMs;
  // Slippage tolerance to account for rounding errors when validating liquidation prices for very small position sizes
  uint64 public positionBelowMinimumLiquidationPriceToleranceMultiplier;

  // State variables - changeable wallets //

  address public dispatcherWallet;
  address public exitFundWallet;
  address public feeWallet;
  address public insuranceFundWallet;

  // Events //

  /**
   * @notice Emitted when an admin changes the Chain Propagation Period tunable parameter with
   * `setChainPropagationPeriod`
   */
  event ChainPropagationPeriodChanged(uint256 previousValue, uint256 newValue);
  /**
   * @notice Emitted when an admin changes the Delegate Key Expiration Period tunable parameter with
   * `setDelegateKeyExpirationPeriod`
   */
  event DelegateKeyExpirationPeriodChanged(uint256 previousValue, uint256 newValue);
  /**
   * @notice Emitted when the Dispatcher Wallet submits an exited wallet position deleverage with
   * `deleverageExitAcquisition`
   */
  event DeleveragedExitAcquisition(
    string baseAssetSymbol,
    address counterpartyWallet,
    address liquidatingWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits an Exit Fund closure deleverage with `deleverageExitFundClosure`
   */
  event DeleveragedExitFundClosure(
    string baseAssetSymbol,
    address counterpartyWallet,
    address exitFundWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits a wallet in maintenance deleverage with
   * `deleverageInMaintenanceAcquisition`
   */
  event DeleveragedInMaintenanceAcquisition(
    string baseAssetSymbol,
    address counterpartyWallet,
    address liquidatingWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits an Insurance Fund closure deleverage with
   * `deleverageInsuranceFundClosure`
   */
  event DeleveragedInsuranceFundClosure(
    string baseAssetSymbol,
    address counterpartyWallet,
    address insuranceFundWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when a user deposits quote tokens with `deposit`
   */
  event Deposited(uint64 index, address sourceWallet, address destinationWallet, uint64 quantity);
  /**
   * @notice Emitted when an admin disables deposits with `setDepositEnabled`
   */
  event DepositsDisabled();
  /**
   * @notice Emitted when an admin enables deposits with `setDepositEnabled`
   */
  event DepositsEnabled();
  /**
   * @notice Emitted when an admin changes the Dispatcher Wallet tunable parameter with `setDispatcher` or clears it
   * with `removeDispatcher`
   */
  event DispatcherChanged(address previousValue, address newValue);
  /**
   * @notice Emitted when an admin changes the Exit Fund Wallet tunable parameter with `setExitFundWallet`
   */
  event ExitFundWalletChanged(address previousValue, address newValue);
  /**
   * @notice Emitted when an admin changes the Fee Wallet tunable parameter with `setFeeWallet`
   */
  event FeeWalletChanged(address previousValue, address newValue);
  /**
   * @notice Emitted when the Dispatch Wallet publishes a new funding rate with `publishFundingMutiplier`
   */
  event FundingRatePublished(string baseAssetSymbol, int64 fundingRate);
  /**
   * @notice Emitted when the Dispatcher Wallet publishes a new index price with `publishIndexPrices`
   */
  event IndexPricePublished(string baseAssetSymbol, uint64 timestampInMs, uint64 price);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a position below minimum liquidation with
   * `liquidatePositionBelowMinimum`
   */
  event LiquidatedPositionBelowMinimum(
    string baseAssetSymbol,
    address liquidatingWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits a position in deactivated market liquidation with
   * `liquidatePositionInDeactivatedMarket`
   */
  event LiquidatedPositionInDeactivatedMarket(
    string baseAssetSymbol,
    address liquidatingWallet,
    uint64 liquidationBaseQuantity,
    uint64 liquidationQuoteQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits an exited wallet liquidation with `liquidateWalletExit`
   */
  event LiquidatedWalletExit(address liquidatingWallet);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a wallet in maintenance liquidation with
   * `liquidateWalletInMaintenance`
   */
  event LiquidatedWalletInMaintenance(address liquidatingWallet);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a wallet in maintenance liquidation during system recovery with
   * `liquidateWalletInMaintenanceDuringSystemRecovery`
   */
  event LiquidatedWalletInMaintenanceDuringSystemRecovery(address liquidatingWallet);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a trade for execution with `executeTrade` and one of the orders
   * has the `isLiquidationAcquisitionOnly` asserted
   */
  event LiquidationAcquisitionExecuted(
    address buyWallet,
    address sellWallet,
    string baseAssetSymbol,
    string quoteAssetSymbol,
    uint64 baseQuantity,
    uint64 quoteQuantity,
    OrderSide makerSide,
    int64 makerFeeQuantity,
    uint64 takerFeeQuantity
  );
  /**
   * @notice Emitted when the Dispatch Wallet activates a previously added market with `activateMarket`
   */
  event MarketActivated(string baseAssetSymbol);
  /**
   * @notice Emitted when admin adds a new market with `addMarket`
   */
  event MarketAdded(string baseAssetSymbol);
  /**
   * @notice Emitted when the Dispatcher Wallet activates a previously activated market with `activateMarket`
   */
  event MarketDeactivated(string baseAssetSymbol);
  /**
   * @notice Emitted when an admin or the Dispatcher Wallet unsets market overrides with `unsetMarketOverridesForWallet`
   */
  event MarketOverridesUnset(string baseAssetSymbol, address wallet);
  /**
   * @notice Emitted when a user invalidates an order nonce with `invalidateNonce`
   */
  event OrderNonceInvalidated(address wallet, uint128 nonce, uint128 timestampInMs, uint256 effectiveBlockTimestamp);
  /**
   * @notice Emitted when pending deposit quantity is applied via `applyPendingDepositsForWallet`
   */
  event PendingDepositApplied(address wallet, uint64 quantity, int64 newExchangeBalance);
  /**
   * @notice Emitted when an admin changes the position below minimum liquidation price tolerance tunable parameter
   * with `setPositionBelowMinimumLiquidationPriceToleranceMultiplier`
   */
  event PositionBelowMinimumLiquidationPriceToleranceMultiplierChanged(uint256 previousValue, uint256 newValue);
  /**
   * @notice Emitted when an admin changes the quote token address with `setQuoteTokenAddress`
   */
  event QuoteTokenAddressChanged(address previousValue, address newValue);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a trade for execution with `executeTrade`
   */
  event TradeExecuted(
    address buyWallet,
    address sellWallet,
    string baseAssetSymbol,
    string quoteAssetSymbol,
    uint64 baseQuantity,
    uint64 quoteQuantity,
    OrderSide makerSide,
    int64 makerFeeQuantity,
    uint64 takerFeeQuantity
  );
  /**
   * @notice Emitted when the Dispatcher Wallet submits a transfer with `transfer`
   */
  event Transferred(
    address destinationWallet,
    address sourceWallet,
    uint64 quantity,
    int64 newDestinationWalletExchangeBalance,
    int64 newSourceWalletExchangeBalance
  );
  /**
   * @notice Emitted when a user clears the exited status of a wallet previously exited with
   * `clearWalletExit`
   */
  event WalletExitCleared(address wallet);
  /**
   * @notice Emitted when a user invokes the Exit Wallet mechanism with `exitWallet`
   */
  event WalletExited(address wallet, uint256 effectiveBlockTimestamp);
  /**
   * @notice Emitted when a user withdraws available quote token balance through the Exit Wallet mechanism with
   * `withdrawExit`
   */
  event WalletExitWithdrawn(address wallet, uint64 quantity);
  /**
   * @notice Emitted when the Dispatcher Wallet submits a withdrawal with `withdraw`
   */
  event Withdrawn(address wallet, uint64 quantity, int64 newExchangeBalance);

  // Modifiers //

  modifier onlyAdminOrDispatcher() {
    require(msg.sender == adminWallet || msg.sender == dispatcherWallet, "Caller must be Admin or Dispatcher wallet");
    _;
  }

  modifier onlyDispatcher() {
    _onlyDispatcher();
    _;
  }

  modifier onlyDispatcherWhenExitFundHasNoPositions() {
    _onlyDispatcher();
    require(baseAssetSymbolsWithOpenPositionsByWallet[exitFundWallet].length == 0, "Exit Fund has open positions");
    _;
  }

  modifier onlyWhenExitFundHasOpenPositions() {
    _onlyWhenExitFundHasOpenPositions();
    _;
  }

  modifier onlyDispatcherWhenExitFundHasOpenPositions() {
    _onlyDispatcher();
    _onlyWhenExitFundHasOpenPositions();
    _;
  }

  modifier onlyGovernance() {
    require(msg.sender == custodian.governance(), "Caller must be Governance contract");
    _;
  }

  // Functions //

  /**
   * @notice Instantiate a new `Exchange` contract
   *
   * @param balanceMigrationSource Previous Exchange contract to migrate wallet balances from. Not used if zero
   * @param exitFundWallet_ Address of EF wallet
   * @param feeWallet_ Address of Fee wallet
   * @param indexPriceAdapters_ Addresses of Index Price Adapter contracts whitelisted to validate index price payloads
   * @param insuranceFundWallet_ Address of IF wallet
   * @param oraclePriceAdapter_ Addresses of Oracle Price Adapter contract used for on-chain exit pricing
   * @param quoteTokenAddress_ Address of quote asset ERC20 contract
   *
   * @dev Sets `owner_` and `admin_` to `msg.sender`
   */
  constructor(
    IExchange balanceMigrationSource,
    address exitFundWallet_,
    address feeWallet_,
    IIndexPriceAdapter[] memory indexPriceAdapters_,
    address insuranceFundWallet_,
    IOraclePriceAdapter oraclePriceAdapter_,
    address quoteTokenAddress_
  ) EIP712(Constants.EIP_712_DOMAIN_NAME, Constants.EIP_712_DOMAIN_VERSION) Owned() {
    require(
      address(balanceMigrationSource) == address(0x0) || Address.isContract(address(balanceMigrationSource)),
      "Invalid migration source"
    );
    _balanceTracking.migrationSource = IExchange(balanceMigrationSource);

    require(Address.isContract(address(quoteTokenAddress_)), "Invalid quote asset address");
    quoteTokenAddress = quoteTokenAddress_;

    setExitFundWallet(exitFundWallet_);

    setFeeWallet(feeWallet_);

    require(insuranceFundWallet_ != address(0x0), "Invalid IF wallet");
    insuranceFundWallet = insuranceFundWallet_;

    for (uint8 i = 0; i < indexPriceAdapters_.length; i++) {
      require(Address.isContract(address(indexPriceAdapters_[i])), "Invalid Index Price Adapter address");
    }
    indexPriceAdapters = indexPriceAdapters_;

    require(Address.isContract(address(oraclePriceAdapter_)), "Invalid Oracle Price Adapter address");
    oraclePriceAdapter = oraclePriceAdapter_;

    // Deposits must be manually enabled via `setDepositIndex` and `setDepositEnabled`
    depositIndex = Constants.DEPOSIT_INDEX_NOT_SET;
  }

  // Tunable parameters //

  /**
   * @notice Sets a new Chain Propagation Period - the block timestamp delay after which order nonce invalidations are
   * respected by `executeTrade` and wallet exits are respected by `executeTrade` and `withdraw`
   *
   * @param newChainPropagationPeriodInS The new Chain Propagation Period expressed in seconds. Must be less than
   * `Constants.MAX_CHAIN_PROPAGATION_PERIOD_IN_S`
   */
  function setChainPropagationPeriod(uint256 newChainPropagationPeriodInS) public onlyAdmin {
    require(newChainPropagationPeriodInS <= Constants.MAX_CHAIN_PROPAGATION_PERIOD_IN_S, "Must be less than max");

    uint256 oldChainPropagationPeriodInS = chainPropagationPeriodInS;
    chainPropagationPeriodInS = newChainPropagationPeriodInS;

    emit ChainPropagationPeriodChanged(oldChainPropagationPeriodInS, newChainPropagationPeriodInS);
  }

  /**
   * @notice Sets a new Delegate Key Expiration Period - the delay following a delegated key's nonce timestamp after
   * which it cannot be used to sign orders
   *
   * @param newDelegateKeyExpirationPeriodInMs The new Delegate Key Expiration Period expressed as milliseconds. Must
   * be less than `Constants.MAX_DELEGATE_KEY_EXPIRATION_PERIOD_IN_MS`
   */
  function setDelegateKeyExpirationPeriod(uint64 newDelegateKeyExpirationPeriodInMs) public onlyAdmin {
    require(
      newDelegateKeyExpirationPeriodInMs <= Constants.MAX_DELEGATE_KEY_EXPIRATION_PERIOD_IN_MS,
      "Must be less than max"
    );

    uint64 oldDelegateKeyExpirationPeriodInMs = delegateKeyExpirationPeriodInMs;
    delegateKeyExpirationPeriodInMs = newDelegateKeyExpirationPeriodInMs;

    emit DelegateKeyExpirationPeriodChanged(oldDelegateKeyExpirationPeriodInMs, newDelegateKeyExpirationPeriodInMs);
  }

  /**
   * @notice Sets a new position below minimum liquidation price tolerance multiplier
   *
   * @param newPositionBelowMinimumLiquidationPriceToleranceMultiplier The new position below minimum liquidation price
   * tolerance multiplier. Must be less than `Constants.MAX_FEE_MULTIPLIER`
   */
  function setPositionBelowMinimumLiquidationPriceToleranceMultiplier(
    uint64 newPositionBelowMinimumLiquidationPriceToleranceMultiplier
  ) public onlyAdmin {
    require(
      newPositionBelowMinimumLiquidationPriceToleranceMultiplier <= Constants.MAX_FEE_MULTIPLIER,
      "Must be less than max"
    );

    uint64 oldPositionBelowMinimumLiquidationPriceToleranceMultiplier = positionBelowMinimumLiquidationPriceToleranceMultiplier;
    positionBelowMinimumLiquidationPriceToleranceMultiplier = newPositionBelowMinimumLiquidationPriceToleranceMultiplier;

    emit PositionBelowMinimumLiquidationPriceToleranceMultiplierChanged(
      oldPositionBelowMinimumLiquidationPriceToleranceMultiplier,
      newPositionBelowMinimumLiquidationPriceToleranceMultiplier
    );
  }

  /**
   * @notice Sets the address of the `Custodian` contract as well as initial cross-chain Bridge Adapter contracts
   *
   * @dev The `Custodian` accepts `Exchange` and `Governance` addresses in its constructor, after which they can only be
   * changed by the `Governance` contract itself. Therefore the `Custodian` must be deployed last and its address set
   * here on an existing `Exchange` contract. This value is immutable once set and cannot be changed again
   *
   * @param newCustodian The address of the `Custodian` contract deployed against this `Exchange` contract's address
   * @param newBridgeAdapters An array of cross-chain Bridge Adapter contract addresses. They can be passed in here as a
   * convenience to avoid waiting the full field upgrade governance delay following initial deploy
   */
  function setCustodian(ICustodian newCustodian, IBridgeAdapter[] memory newBridgeAdapters) public onlyAdmin {
    require(custodian == ICustodian(payable(address(0x0))), "Custodian can only be set once");
    require(Address.isContract(address(newCustodian)), "Invalid address");

    custodian = newCustodian;

    for (uint8 i = 0; i < newBridgeAdapters.length; i++) {
      require(Address.isContract(address(newBridgeAdapters[i])), "Invalid adapter address");
    }

    bridgeAdapters = newBridgeAdapters;
  }

  /**
   * @notice Enable depositing assets into the Exchange by setting the current deposit index from
   * the old Exchange contract's value. This function can only be called once
   */
  function setDepositIndex() public onlyAdmin {
    require(depositIndex == Constants.DEPOSIT_INDEX_NOT_SET, "Can only be set once");

    depositIndex = address(_balanceTracking.migrationSource) == address(0x0)
      ? 0
      : _balanceTracking.migrationSource.depositIndex();
  }

  /**
   * @notice Enables or disables depositing assets into the Exchange
   *
   * @param isEnabled Enables deposit if true, disables if false
   */
  function setDepositEnabled(bool isEnabled) public onlyAdmin {
    if (isEnabled) {
      require(!isDepositEnabled, "Deposits already enabled");
      emit DepositsEnabled();
    } else {
      require(isDepositEnabled, "Deposits already disabled");
      emit DepositsDisabled();
    }

    isDepositEnabled = isEnabled;
  }

  /**
   * @notice Sets the address of the Exit Fund wallet
   *
   * @dev The current Exit Fund wallet cannot have any open balances
   *
   * @param newExitFundWallet The new Exit Fund wallet. Must be different from the current one
   */
  function setExitFundWallet(address newExitFundWallet) public onlyAdmin {
    require(newExitFundWallet != address(0x0), "Invalid EF wallet address");
    require(newExitFundWallet != exitFundWallet, "Must be different from current");

    require(
      !ExitFund.doesWalletHaveOpenPositionsOrQuoteBalance(
        exitFundWallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet
      ),
      "Current EF cannot have open balance"
    );

    require(
      !ExitFund.doesWalletHaveOpenPositionsOrQuoteBalance(
        newExitFundWallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet
      ),
      "New EF cannot have open balance"
    );

    address oldExitFundWallet = exitFundWallet;
    exitFundWallet = newExitFundWallet;

    emit ExitFundWalletChanged(oldExitFundWallet, newExitFundWallet);
  }

  /**
   * @notice Sets the address of the Fee wallet
   *
   * @dev Trade and Withdraw fees will accrue in the `_balanceTracking` quote mapping for this wallet
   *
   * @param newFeeWallet The new Fee wallet. Must be different from the current one
   */
  function setFeeWallet(address newFeeWallet) public onlyAdmin {
    require(newFeeWallet != address(0x0), "Invalid fee wallet address");
    require(newFeeWallet != feeWallet, "Must be different from current");

    address oldFeeWallet = feeWallet;
    feeWallet = newFeeWallet;

    emit FeeWalletChanged(oldFeeWallet, newFeeWallet);
  }

  /**
   * @notice Sets Bridge Adapter contract addresses whitelisted for withdrawals
   *
   * @param newBridgeAdapters An array of Bridge Adapter contract addresses
   */
  function setBridgeAdapters(IBridgeAdapter[] memory newBridgeAdapters) public onlyGovernance {
    bridgeAdapters = newBridgeAdapters;
  }

  /**
   * @notice Sets Index Price Adapter contract addresses
   *
   * @param newIndexPriceAdapters An array of contract addresses
   */
  function setIndexPriceAdapters(IIndexPriceAdapter[] memory newIndexPriceAdapters) public onlyGovernance {
    indexPriceAdapters = newIndexPriceAdapters;
  }

  /**
   * @notice Sets IF wallet address
   *
   * @param newInsuranceFundWallet The new IF wallet address
   */
  function setInsuranceFundWallet(address newInsuranceFundWallet) public onlyGovernance {
    require(!walletExits[newInsuranceFundWallet].exists, "IF wallet cannot be exited");
    insuranceFundWallet = newInsuranceFundWallet;
  }

  /**
   * @notice Sets Oracle Price Adapter contract address used for on-chain exit pricing
   *
   * @param newOraclePriceAdapter The new contract addresses
   */
  function setOraclePriceAdapter(IOraclePriceAdapter newOraclePriceAdapter) public onlyGovernance {
    oraclePriceAdapter = newOraclePriceAdapter;
  }

  /**
   * @notice Migrates all quote asset funds held by Custodian to new token contract and sets new `quoteTokenAddress`
   */
  function migrateQuoteTokenAddress() public onlyAdmin {
    address oldQuoteTokenAddress = quoteTokenAddress;

    address newQuoteTokenAddress = custodian.migrateAsset(quoteTokenAddress);
    quoteTokenAddress = newQuoteTokenAddress;

    emit QuoteTokenAddressChanged(oldQuoteTokenAddress, newQuoteTokenAddress);
  }

  /**
   * @notice Load a wallet's balance by asset symbol, in pips
   *
   * @param wallet The wallet address to load the balance for. Can be different from `msg.sender`
   * @param assetSymbol The asset symbol to load the wallet's balance for
   *
   * @return balance The quantity denominated in pips of asset at `assetSymbol` currently in an open position or
   * quote balance by `wallet` if base or quote respectively. Result may be negative
   */
  function loadBalanceBySymbol(address wallet, string memory assetSymbol) public view override returns (int64 balance) {
    balance = _balanceTracking.loadBalanceFromMigrationSourceIfNeeded(wallet, assetSymbol);

    if (String.isEqual(assetSymbol, Constants.QUOTE_ASSET_SYMBOL)) {
      balance +=
        Funding.loadOutstandingWalletFunding_delegatecall(
          wallet,
          _balanceTracking,
          baseAssetSymbolsWithOpenPositionsByWallet,
          fundingMultipliersByBaseAssetSymbol,
          lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
          _marketsByBaseAssetSymbol
        ) +
        Math.toInt64(pendingDepositQuantityByWallet[wallet]);
    }
  }

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
    string memory assetSymbol
  ) public view override returns (Balance memory) {
    return _balanceTracking.loadBalanceStructFromMigrationSourceIfNeeded(wallet, assetSymbol);
  }

  /**
   * @notice Loads a list of all currently open positions for a wallet
   *
   * @param wallet The wallet address to load open positions for for. Can be different from `msg.sender`
   *
   * @return A list of base asset symbols corresponding to markets in which the wallet currently has an open position
   */
  function loadBaseAssetSymbolsWithOpenPositionsByWallet(
    address wallet
  ) public view override returns (string[] memory) {
    return baseAssetSymbolsWithOpenPositionsByWallet[wallet];
  }

  /**
   * @notice Loads the total count of all markets added
   *
   * @return The total count of all markets added
   *
   */
  function loadMarketsLength() public view returns (uint256) {
    return marketBaseAssetSymbols.length;
  }

  /**
   * @notice Loads the Market at the given index by addition order
   *
   * @param index The index at which to load
   *
   * @return The Market at the given index by addition order
   */
  function loadMarket(uint8 index) public view returns (Market memory) {
    return _marketsByBaseAssetSymbol[marketBaseAssetSymbols[index]];
  }

  /**
   * @notice Loads the last nonce invalidation created by a wallet
   *
   * @param wallet The wallet address
   *
   * @return nonceInvalidation The most recent nonce invalidation struct created by the wallet with `invalidateNonce`. Struct will be
   * empty if wallet has never invalidated a nonce
   */
  function loadLastNonceInvalidationForWallet(
    address wallet
  ) public view returns (NonceInvalidation memory nonceInvalidation) {
    if (nonceInvalidationsByWallet[wallet].length > 0) {
      nonceInvalidation = nonceInvalidationsByWallet[wallet][nonceInvalidationsByWallet[wallet].length - 1];
    }
  }

  /**
   * @notice Load the balance of quote asset the wallet can withdraw after exiting, in pips. Note that due to changing
   * prices the value returned is only an estimate and may not exactly match the value actually transferred after exit
   *
   * @param wallet The wallet address to load the exit quote balance for. Can be different from `msg.sender`
   *
   * @return balance The quantity denominated in pips of quote asset that can be withdrawn after exiting the wallet.
   * Result may be zero, in which case an exit withdrawal would not transfer out any quote but would still close all
   * positions and quote balance. The available quote for exit withdrawal can validly be negative for the EF wallet, in
   * which case this function will return 0 since no withdrawal is possible. For all other wallets, the exit quote
   * calculations are designed such that the result quantity to withdraw is never negative; however the return type is
   * still signed to provide visibility into unforeseen bugs or rounding errors
   */
  function loadQuoteQuantityAvailableForExitWithdrawal(address wallet) public view returns (int64) {
    return
      OraclePriceMargin.loadQuoteQuantityAvailableForExitWithdrawalIncludingOutstandingWalletFunding_delegatecall(
        exitFundWallet,
        oraclePriceAdapter,
        wallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol,
        pendingDepositQuantityByWallet
      );
  }

  // Dispatcher whitelisting //

  /**
   * @notice Sets the wallet whitelisted to dispatch transactions calling the `executeTrade` and `withdraw`
   * functions
   *
   * @param newDispatcherWallet The new whitelisted dispatcher wallet. Must be different from the current one
   */
  function setDispatcher(address newDispatcherWallet) public onlyAdmin {
    require(newDispatcherWallet != address(0x0), "Invalid wallet address");
    require(newDispatcherWallet != dispatcherWallet, "Must be different from current");

    emit DispatcherChanged(dispatcherWallet, newDispatcherWallet);

    dispatcherWallet = newDispatcherWallet;
  }

  /**
   * @notice Clears the currently set whitelisted dispatcher wallet, effectively disabling calling any functions
   * restricted by the `onlyDispatcherWhenExitFundHasNoPositions` modifier until a new wallet is set with `setDispatcher`
   */
  function removeDispatcher() public onlyAdmin {
    emit DispatcherChanged(dispatcherWallet, address(0x0));

    dispatcherWallet = address(0x0);
  }

  // Depositing //

  /**
   * @notice Deposit quote token
   *
   * @param quantityInAssetUnits The quantity to deposit. The sending wallet must first call the `approve` method on
   * the token contract for at least this quantity
   * @param destinationWallet The wallet which will be credited for the new balance. Defaults to sending wallet if zero
   */
  function deposit(uint256 quantityInAssetUnits, address destinationWallet) public {
    address destinationWallet_ = destinationWallet == address(0x0) ? msg.sender : destinationWallet;

    Depositing.deposit_delegatecall(
      Depositing.DepositArguments(
        destinationWallet_,
        msg.sender,
        quantityInAssetUnits,
        custodian,
        depositIndex,
        exitFundWallet,
        isDepositEnabled,
        quoteTokenAddress
      ),
      pendingDepositQuantityByWallet,
      walletExits
    );

    depositIndex++;
  }

  /**
   * @notice Apply pending deposits
   *
   * @param quantity The quantity to apply. Must be less than or equal to the total amount pending for the wallet
   * @param wallet The wallet for which to apply pending deposits
   */
  function applyPendingDepositsForWallet(uint64 quantity, address wallet) public onlyAdminOrDispatcher {
    Depositing.applyPendingDepositsForWallet_delegatecall(
      quantity,
      wallet,
      _balanceTracking,
      pendingDepositQuantityByWallet
    );
  }

  // Trades //

  /**
   * @notice Settles a trade between two orders submitted and matched off-chain
   *
   * @param tradeArguments An `ExecuteTradeArguments` struct encoding the buy order, sell order, and trade
   * execution parameters
   */
  function executeTrade(ExecuteTradeArguments memory tradeArguments) public onlyDispatcherWhenExitFundHasNoPositions {
    Trading.executeTrade_delegatecall(
      Trading.Arguments(
        tradeArguments,
        delegateKeyExpirationPeriodInMs,
        _domainSeparatorV4(),
        exitFundWallet,
        feeWallet,
        insuranceFundWallet
      ),
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      _completedOrderHashes,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      nonceInvalidationsByWallet,
      _partiallyFilledOrderQuantities,
      walletExits
    );
  }

  // Liquidation //

  /**
   * @notice Liquidates a single position below the market's configured `minimumPositionSize` to the Insurance Fund
   * at the current index price
   */
  function liquidatePositionBelowMinimum(
    PositionBelowMinimumLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    PositionBelowMinimumLiquidation.liquidate_delegatecall(
      liquidationArguments,
      exitFundWallet,
      insuranceFundWallet,
      positionBelowMinimumLiquidationPriceToleranceMultiplier,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Liquidates a single position in a deactivated market at the previously set index price
   */
  function liquidatePositionInDeactivatedMarket(
    PositionInDeactivatedMarketLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    PositionInDeactivatedMarketLiquidation.liquidate_delegatecall(
      liquidationArguments,
      feeWallet,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Liquidates all positions held by a wallet below maintenance requirements to the Insurance Fund at each
   * position's bankruptcy price
   */
  function liquidateWalletInMaintenance(
    WalletLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    WalletInMaintenanceLiquidation.liquidate_delegatecall(
      liquidationArguments,
      exitFundPositionOpenedAtBlockTimestamp, // Will always be 0 per modifier
      exitFundWallet,
      insuranceFundWallet,
      LiquidationType.WalletInMaintenance,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Liquidates all positions held by a wallet below maintenance requirements to the Exit Fund at each
   * position's bankruptcy price
   */
  function liquidateWalletInMaintenanceDuringSystemRecovery(
    WalletLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasOpenPositions {
    exitFundPositionOpenedAtBlockTimestamp = WalletInMaintenanceLiquidation.liquidate_delegatecall(
      liquidationArguments,
      exitFundPositionOpenedAtBlockTimestamp,
      exitFundWallet,
      insuranceFundWallet,
      LiquidationType.WalletInMaintenanceDuringSystemRecovery,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Liquidates all positions of an exited wallet to the Insurance Fund at each position's exit price
   */
  function liquidateWalletExit(
    WalletLiquidationArguments memory liquidationArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    require(walletExits[liquidationArguments.liquidatingWallet].exists, "Wallet not exited");

    WalletExitLiquidation.liquidate_delegatecall(
      liquidationArguments,
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  // Automatic Deleveraging (ADL) //

  /**
   * @notice Reduces a single position held by a wallet below maintenance requirements by deleveraging a counterparty
   * position at the bankruptcy price of the liquidating wallet
   */
  function deleverageInMaintenanceAcquisition(
    AcquisitionDeleverageArguments memory deleverageArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    WalletInMaintenanceAcquisitionDeleveraging.deleverage_delegatecall(
      deleverageArguments,
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Reduces a single position held by the Insurance Fund by deleveraging a counterparty position at the entry
   * price of the Insurance Fund
   */
  function deleverageInsuranceFundClosure(
    ClosureDeleverageArguments memory deleverageArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    ClosureDeleveraging.deleverage_delegatecall(
      deleverageArguments,
      DeleverageType.InsuranceFundClosure,
      exitFundPositionOpenedAtBlockTimestamp, // Will always be 0 per modifier
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Reduces a single position held by an exited wallet by deleveraging a counterparty position at the exit
   * price of the liquidating wallet
   */
  function deleverageExitAcquisition(
    AcquisitionDeleverageArguments memory deleverageArguments
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    require(walletExits[deleverageArguments.liquidatingWallet].exists, "Wallet not exited");

    WalletExitAcquisitionDeleveraging.deleverage_delegatecall(
      deleverageArguments,
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      walletExits
    );
  }

  /**
   * @notice Reduces a single position held by the Exit Fund by deleveraging a counterparty position at the index
   * price or the Exit Fund's bankruptcy price if the Exit Fund account value is positive or negative, respectively
   */
  function deleverageExitFundClosure(
    ClosureDeleverageArguments memory deleverageArguments
  ) public onlyDispatcherWhenExitFundHasOpenPositions {
    exitFundPositionOpenedAtBlockTimestamp = ClosureDeleveraging.deleverage_delegatecall(
      deleverageArguments,
      DeleverageType.ExitFundClosure,
      exitFundPositionOpenedAtBlockTimestamp,
      exitFundWallet,
      insuranceFundWallet,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  // Transfers //

  function transfer(Transfer memory transfer_) public onlyDispatcherWhenExitFundHasNoPositions {
    Transferring.transfer_delegatecall(
      Transferring.Arguments(transfer_, _domainSeparatorV4(), exitFundWallet, insuranceFundWallet, feeWallet),
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      _completedTransferHashes,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      walletExits
    );
  }

  // Withdrawing //

  /**
   * @notice Settles a user withdrawal submitted off-chain. Calls restricted to currently
   * whitelisted Dispatcher wallet
   *
   * @param withdrawal A `Withdrawal` struct encoding the parameters of the withdrawal
   */
  function withdraw(Withdrawal memory withdrawal) public onlyDispatcherWhenExitFundHasNoPositions {
    require(!WalletExits.isWalletExitFinalized(withdrawal.wallet, walletExits), "Wallet exited");

    Withdrawing.withdraw_delegatecall(
      Withdrawing.WithdrawArguments(
        withdrawal,
        _domainSeparatorV4(),
        custodian,
        exitFundPositionOpenedAtBlockTimestamp,
        exitFundWallet,
        feeWallet,
        quoteTokenAddress
      ),
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      _completedWithdrawalHashes,
      bridgeAdapters,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol
    );
  }

  // Market management //

  /**
   * @notice Create a new market that will initially be deactivated. Funding multipliers will be backfilled with zero
   * values for the current day UTC. Note this may block publishing new funding multipliers for up to half the funding
   * period interval following market creation
   */
  function addMarket(Market memory newMarket) public onlyAdmin {
    MarketAdmin.addMarket_delegatecall(
      newMarket,
      _balanceTracking.migrationSource,
      oraclePriceAdapter,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketBaseAssetSymbols,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Activate a market, which allows positions to be opened and funding payments made
   */
  function activateMarket(string memory baseAssetSymbol) public onlyDispatcherWhenExitFundHasNoPositions {
    MarketAdmin.activateMarket_delegatecall(baseAssetSymbol, _marketsByBaseAssetSymbol);
  }

  /**
   * @notice Deactivate a market
   */
  function deactivateMarket(string memory baseAssetSymbol) public onlyDispatcherWhenExitFundHasNoPositions {
    MarketAdmin.deactivateMarket_delegatecall(baseAssetSymbol, _marketsByBaseAssetSymbol);
  }

  /**
   * @notice Publish updated index prices for markets
   *
   * @dev Access must be `onlyDispatcher` rather than `onlyDispatcherWhenExitFundHasNoPositions` to facilitate EF
   * closure deleveraging during system recovery
   */
  function publishIndexPrices(IndexPricePayload[] memory encodedIndexPrices) public onlyDispatcher {
    MarketAdmin.publishIndexPrices_delegatecall(encodedIndexPrices, indexPriceAdapters, _marketsByBaseAssetSymbol);
  }

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
  ) public onlyGovernance {
    require(_marketsByBaseAssetSymbol[baseAssetSymbol].exists, "Invalid market");

    if (wallet == address(0x0)) {
      _marketsByBaseAssetSymbol[baseAssetSymbol].overridableFields = overridableFields;
    } else {
      marketOverridesByBaseAssetSymbolAndWallet[baseAssetSymbol][wallet] = MarketOverrides({
        exists: true,
        overridableFields: overridableFields
      });
    }
  }

  /**
   * @notice Unset overridable market parameters for a specific wallet
   *
   * @param baseAssetSymbol The base asset symbol for the market
   * @param wallet The wallet to unset overrides for
   */
  function unsetMarketOverridesForWallet(string memory baseAssetSymbol, address wallet) public onlyAdminOrDispatcher {
    require(_marketsByBaseAssetSymbol[baseAssetSymbol].exists, "Invalid market");
    require(wallet != address(0x0), "Invalid wallet");
    require(
      marketOverridesByBaseAssetSymbolAndWallet[baseAssetSymbol][wallet].exists,
      "Wallet has no overrides for market"
    );

    delete marketOverridesByBaseAssetSymbolAndWallet[baseAssetSymbol][wallet];

    emit MarketOverridesUnset(baseAssetSymbol, wallet);
  }

  /**
   * @notice Sends tokens mistakenly sent directly to the `Exchange` to the fee wallet (the absence of a `receive`
   * function rejects incoming native asset transfers)
   */
  function skim(address tokenAddress) public onlyAdmin {
    Withdrawing.skim_delegatecall(tokenAddress, feeWallet);
  }

  // Perps //

  /**
   * @notice Pushes fundingRate × indexPrice to fundingMultipliersByBaseAssetSymbol mapping for market. Uses timestamp
   * component of index price to determine if funding rate is too recent after previously publish funding rate, and to
   * backfill empty values if a funding period was missed
   */
  function publishFundingMultiplier(
    string memory baseAssetSymbol,
    int64 fundingRate
  ) public onlyDispatcherWhenExitFundHasNoPositions {
    Funding.publishFundingMultiplier_delegatecall(
      baseAssetSymbol,
      fundingRate,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _marketsByBaseAssetSymbol
    );

    emit FundingRatePublished(baseAssetSymbol, fundingRate);
  }

  /**
   * @notice Updates quote balance with historical funding payments for a market by walking funding multipliers
   * published since last position update up to max allowable by gas constraints
   */
  function applyOutstandingWalletFundingForMarket(address wallet, string memory baseAssetSymbol) public {
    Funding.applyOutstandingWalletFundingForMarket_delegatecall(
      baseAssetSymbol,
      wallet,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      _marketsByBaseAssetSymbol
    );
  }

  /**
   * @notice Calculate total outstanding funding payments
   */
  function loadOutstandingWalletFunding(address wallet) public view returns (int64) {
    return
      Funding.loadOutstandingWalletFunding_delegatecall(
        wallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        _marketsByBaseAssetSymbol
      );
  }

  /**
   * @notice Calculate total account value for a wallet by summing its quote asset balance and each open position's
   * notional values as computed by latest published index price. Result may be negative. Since index prices are
   * published lazily, the result may be out of date for a market with little activity
   *
   * @param wallet The wallet address to calculate total account value for
   */
  function loadTotalAccountValueFromIndexPrices(address wallet) public view returns (int64) {
    return
      IndexPriceMargin.loadTotalAccountValueIncludingOutstandingWalletFunding_delegatecall(
        wallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        _marketsByBaseAssetSymbol,
        pendingDepositQuantityByWallet
      );
  }

  /**
   * @notice Calculate total account value for a wallet by summing its quote asset balance and each open position's
   * notional values as computed by on-chain feed price. Result may be negative
   *
   * @param wallet The wallet address to calculate total account value for
   */
  function loadTotalAccountValueFromOraclePrices(address wallet) public view returns (int64) {
    return
      OraclePriceMargin.loadTotalAccountValueIncludingOutstandingWalletFunding_delegatecall(
        oraclePriceAdapter,
        wallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        fundingMultipliersByBaseAssetSymbol,
        lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
        _marketsByBaseAssetSymbol,
        pendingDepositQuantityByWallet
      );
  }

  /**
   * @notice Calculate total initial margin requirement for a wallet by summing each open position's initial margin
   * requirement as computed by latest published index price. Since index prices are published lazily, the result may be
   * out of date for a market with little activity
   *
   * @param wallet The wallet address to calculate total initial margin requirement for
   */
  function loadTotalInitialMarginRequirementFromIndexPrices(address wallet) public view returns (uint64) {
    return
      IndexPriceMargin.loadTotalInitialMarginRequirement_delegatecall(
        wallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol
      );
  }

  /**
   * @notice Calculate total initial margin requirement for a wallet by summing each open position's initial margin
   * requirement as computed by on-chain feed price
   *
   * @param wallet The wallet address to calculate total initial margin requirement for
   */
  function loadTotalInitialMarginRequirementFromOraclePrices(address wallet) public view returns (uint64) {
    return
      OraclePriceMargin.loadTotalInitialMarginRequirement_delegatecall(
        oraclePriceAdapter,
        wallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol
      );
  }

  /**
   * @notice Calculate total maintenence margin requirement for a wallet by summing each open position's maintanence
   * margin requirement as computed by latest published index price. Since index prices are published lazily, the result
   * may be out of date for a market with little activity
   *
   * @param wallet The wallet address to calculate total maintanence margin requirement for
   */
  function loadTotalMaintenanceMarginRequirementFromIndexPrices(address wallet) public view returns (uint64) {
    return
      IndexPriceMargin.loadTotalMaintenanceMarginRequirement_delegatecall(
        wallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol
      );
  }

  /**
   * @notice Calculate total maintenence margin requirement for a wallet by summing each open position's maintanence
   * margin requirement as computed by on-chain feed price
   *
   * @param wallet The wallet address to calculate total maintanence margin requirement for
   */
  function loadTotalMaintenanceMarginRequirementFromOraclePrices(address wallet) public view returns (uint64) {
    return
      OraclePriceMargin.loadTotalMaintenanceMarginRequirement_delegatecall(
        oraclePriceAdapter,
        wallet,
        _balanceTracking,
        baseAssetSymbolsWithOpenPositionsByWallet,
        marketOverridesByBaseAssetSymbolAndWallet,
        _marketsByBaseAssetSymbol
      );
  }

  // Wallet exits //

  /**
   * @notice Flags the sending wallet as exited, immediately disabling deposits upon mining. After the Chain Propagation
   * Period passes trades and withdrawals are also disabled for the wallet, and quote asset may then be withdrawn via
   * `withdrawExit`
   */
  function exitWallet() public {
    Withdrawing.exitWallet_delegatecall(
      chainPropagationPeriodInS,
      exitFundWallet,
      insuranceFundWallet,
      msg.sender,
      walletExits
    );
  }

  /**
   * @notice Close all open positions and withdraw the net quote balance for an exited wallet. The Chain Propagation
   * Period must have already passed since calling `exitWallet`
   *
   * @param wallet Address of exited wallet
   */
  function withdrawExit(address wallet) public {
    uint256 exitFundPositionOpenedAtBlockTimestamp_ = Withdrawing.withdrawExit_delegatecall(
      Withdrawing.WithdrawExitArguments(wallet, custodian, exitFundWallet, oraclePriceAdapter, quoteTokenAddress),
      exitFundPositionOpenedAtBlockTimestamp,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      pendingDepositQuantityByWallet,
      walletExits
    );

    exitFundPositionOpenedAtBlockTimestamp = exitFundPositionOpenedAtBlockTimestamp_;
  }

  /**
   * @notice Close all open positions and withdraw the net quote balance for an exited wallet during system recovery,
   * regardless of Chain Propagation Period elapsing
   *
   * @param wallet Address of exited wallet
   */
  function withdrawExitAdmin(address wallet) public onlyAdminOrDispatcher onlyWhenExitFundHasOpenPositions {
    uint256 exitFundPositionOpenedAtBlockTimestamp_ = Withdrawing.withdrawExitAdmin_delegatecall(
      Withdrawing.WithdrawExitArguments(wallet, custodian, exitFundWallet, oraclePriceAdapter, quoteTokenAddress),
      exitFundPositionOpenedAtBlockTimestamp,
      _balanceTracking,
      baseAssetSymbolsWithOpenPositionsByWallet,
      fundingMultipliersByBaseAssetSymbol,
      lastFundingRatePublishTimestampInMsByBaseAssetSymbol,
      marketOverridesByBaseAssetSymbolAndWallet,
      _marketsByBaseAssetSymbol,
      walletExits
    );
    exitFundPositionOpenedAtBlockTimestamp = exitFundPositionOpenedAtBlockTimestamp_;
  }

  /**
   * @notice Clears exited status of sending wallet. Upon mining immediately enables deposits, trades, and withdrawals
   * by sending wallet
   */
  function clearWalletExit() public {
    require(WalletExits.isWalletExitFinalized(msg.sender, walletExits), "Wallet exit not finalized");
    require(
      baseAssetSymbolsWithOpenPositionsByWallet[msg.sender].length == 0 &&
        _balanceTracking.loadBalanceFromMigrationSourceIfNeeded(msg.sender, Constants.QUOTE_ASSET_SYMBOL) == 0,
      "Must withdraw exit before clearing"
    );

    delete walletExits[msg.sender];

    emit WalletExitCleared(msg.sender);
  }

  // Invalidation //

  /**
   * @notice Invalidate all order nonces with a timestampInMs lower than the one provided
   *
   * @param nonce A Version 1 UUID. After calling and once the Chain Propagation Period has elapsed,
   * `executeTrade` will reject order nonces from this wallet with a timestampInMs component lower than the one
   * provided
   */
  function invalidateNonce(uint128 nonce) public {
    (uint64 timestampInMs, uint256 effectiveBlockTimestamp) = nonceInvalidationsByWallet.invalidateNonce(
      nonce,
      chainPropagationPeriodInS
    );

    emit OrderNonceInvalidated(msg.sender, nonce, timestampInMs, effectiveBlockTimestamp);
  }

  function _onlyDispatcher() private view {
    require(msg.sender == dispatcherWallet, "Caller must be Dispatcher wallet");
  }

  function _onlyWhenExitFundHasOpenPositions() private view {
    require(baseAssetSymbolsWithOpenPositionsByWallet[exitFundWallet].length > 0, "Exit Fund has no positions");
  }
}
