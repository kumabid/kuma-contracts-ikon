// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { Constants } from "../libraries/Constants.sol";
import { Hashing } from "../libraries/Hashing.sol";
import { Owned } from "../Owned.sol";
import { String } from "../libraries/String.sol";
import { IExchange, IIndexPriceAdapter, IOraclePriceAdapter } from "../libraries/Interfaces.sol";
import { IndexPrice, Market } from "../libraries/Structs.sol";

contract KumaIndexAndOraclePriceAdapter is IIndexPriceAdapter, IOraclePriceAdapter, Owned {
  bytes32 public constant EIP_712_TYPE_HASH_INDEX_PRICE =
    keccak256("IndexPrice(string baseAssetSymbol,string quoteAssetSymbol,uint64 timestampInMs,string price)");
  // Address whitelisted to call `setActive`
  address public immutable activator;
  // Address of Exchange contract
  IExchange public exchange;
  // EIP-712 domain separator hash for Exchange
  bytes32 public exchangeDomainSeparator;
  // IPS wallet addresses whitelisted to sign index price payloads
  address[] public indexPriceServiceWallets;
  // Mapping of base asset symbol => index price struct
  mapping(string => IndexPrice) public latestIndexPriceByBaseAssetSymbol;

  modifier onlyActivator() {
    require(msg.sender == activator, "Caller must be activator");
    _;
  }

  modifier onlyExchange() {
    require(_isActive(), "Exchange not set");
    require(msg.sender == address(exchange), "Caller must be Exchange contract");
    _;
  }

  /**
   * @notice Instantiate a new `KumaIndexAndOraclePriceAdapter` contract
   *
   * @param activator_ Address whitelisted to call `setActive`
   * @param indexPriceServiceWallets_ Addresses of IPS wallets whitelisted to sign index prices
   */
  constructor(address activator_, address[] memory indexPriceServiceWallets_) Owned() {
    require(activator_ != address(0x0), "Invalid activator address");
    activator = activator_;

    require(indexPriceServiceWallets_.length > 0, "Missing IPS wallets");
    for (uint8 i = 0; i < indexPriceServiceWallets_.length; i++) {
      require(indexPriceServiceWallets_[i] != address(0x0), "Invalid IPS wallet");
    }
    indexPriceServiceWallets = indexPriceServiceWallets_;
  }

  /**
   * @notice Return latest price for base asset symbol in quote asset terms. Reverts if no price is available
   */
  function loadPriceForBaseAssetSymbol(string memory baseAssetSymbol) public view returns (uint64 price) {
    IndexPrice memory indexPrice = latestIndexPriceByBaseAssetSymbol[baseAssetSymbol];
    if (indexPrice.price == 0) {
      return 1;
    }
    // require(indexPrice.price > 0, "Missing price");

    return indexPrice.price;
  }

  /**
   * @notice Sets adapter as active, indicating that it is now whitelisted by the Exchange
   */
  function setActive(IExchange exchange_) public override(IIndexPriceAdapter, IOraclePriceAdapter) onlyActivator {
    if (_isActive()) {
      // When used for both oracle and index price roles, this function will validly be called twice
      return;
    }

    require(Address.isContract(address(exchange_)), "Invalid Exchange contract address");

    exchange = exchange_;
    exchangeDomainSeparator = keccak256(
      abi.encode(
        Constants.EIP_712_TYPE_HASH_DOMAIN,
        keccak256(bytes(Constants.EIP_712_DOMAIN_NAME)),
        keccak256(bytes(Constants.EIP_712_DOMAIN_VERSION)),
        block.chainid,
        exchange_
      )
    );

    Market memory market;
    for (uint8 i = 0; i < exchange.loadMarketsLength(); i++) {
      market = exchange.loadMarket(i);
      latestIndexPriceByBaseAssetSymbol[market.baseAssetSymbol] = IndexPrice(
        market.baseAssetSymbol,
        market.lastIndexPriceTimestampInMs,
        market.lastIndexPrice
      );
    }
  }

  /**
   * @notice Validate encoded payload and return `IndexPrice` struct
   *
   * @dev If this adapter has not yet been set active, `onlyExchange` will revert
   */
  function validateIndexPricePayload(bytes memory payload) public onlyExchange returns (IndexPrice memory) {
    IndexPrice memory indexPrice = _validateIndexPricePayload(payload);

    if (latestIndexPriceByBaseAssetSymbol[indexPrice.baseAssetSymbol].timestampInMs < indexPrice.timestampInMs) {
      latestIndexPriceByBaseAssetSymbol[indexPrice.baseAssetSymbol] = indexPrice;
    }

    return indexPrice;
  }

  /**
   * @notice Validate an encoded payload in order to set initial price for a new market
   *
   * @dev When adding a new market, `MarketAdmin` sets the initial price from the current oracle price adapter. This
   * contract sources oracle price data from index price payloads it has already seen, so to avoid reversion when
   * adding a new market an index price payload corresponding to the new market must first be provided to this function
   */
  function validateInitialIndexPricePayloadAdmin(bytes memory payload) public onlyAdmin {
    require(_isActive(), "Exchange not set");

    IndexPrice memory indexPrice = _validateIndexPricePayload(payload);

    require(
      latestIndexPriceByBaseAssetSymbol[indexPrice.baseAssetSymbol].timestampInMs == 0,
      "Price already exists for market"
    );

    latestIndexPriceByBaseAssetSymbol[indexPrice.baseAssetSymbol] = indexPrice;
  }

  function _isActive() private view returns (bool) {
    return address(exchange) != address(0x0);
  }

  function _validateIndexPricePayload(bytes memory payload) private view returns (IndexPrice memory) {
    (IndexPrice memory indexPrice, bytes memory signature) = abi.decode(payload, (IndexPrice, bytes));

    require(indexPrice.price > 0, "Unexpected non-positive price");

    // Extract signer from signature
    address signer = Hashing.getSigner(
      exchangeDomainSeparator,
      keccak256(
        abi.encode(
          EIP_712_TYPE_HASH_INDEX_PRICE,
          keccak256(bytes(indexPrice.baseAssetSymbol)),
          keccak256(bytes(Constants.QUOTE_ASSET_SYMBOL)),
          indexPrice.timestampInMs,
          keccak256(bytes(String.pipsToDecimalString(indexPrice.price)))
        )
      ),
      signature
    );

    // Verify signer is whitelisted
    bool isSignatureValid = false;
    for (uint8 i = 0; i < indexPriceServiceWallets.length; i++) {
      isSignatureValid = isSignatureValid || signer == indexPriceServiceWallets[i];
    }
    require(isSignatureValid, "Invalid index price signature");

    return indexPrice;
  }
}
