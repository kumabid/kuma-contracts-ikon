// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

/**
 * @dev See GOVERNANCE.md for descriptions of fixed parameters and fees
 */

library Constants {
  uint64 public constant DEPOSIT_INDEX_NOT_SET = type(uint64).max;

  string public constant EIP_712_DOMAIN_NAME = "Kuma";

  string public constant EIP_712_DOMAIN_VERSION = "1.0.0-sandbox";

  // https://eips.ethereum.org/EIPS/eip-712#definition-of-domainseparator
  bytes32 public constant EIP_712_TYPE_HASH_DOMAIN =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

  bytes32 public constant EIP_712_TYPE_HASH_DELEGATED_KEY_AUTHORIZATION =
    keccak256("DelegatedKeyAuthorization(uint128 nonce,address delegatedPublicKey,string message)");

  bytes32 public constant EIP_712_TYPE_HASH_ORDER =
    keccak256(
      "Order(uint128 nonce,address wallet,string marketSymbol,uint8 orderType,uint8 orderSide,string quantity,string limitPrice,string triggerPrice,uint8 triggerType,string callbackRate,uint128 conditionalOrderId,bool isReduceOnly,uint8 timeInForce,uint8 selfTradePrevention,bool isLiquidationAcquisitionOnly,address delegatedPublicKey,string clientOrderId)"
    );

  bytes32 public constant EIP_712_TYPE_HASH_TRANSFER =
    keccak256("Transfer(uint128 nonce,address sourceWallet,address destinationWallet,string quantity)");

  bytes32 public constant EIP_712_TYPE_HASH_WITHDRAWAL =
    keccak256(
      "Withdrawal(uint128 nonce,address wallet,string quantity,string maximumGasFee,address bridgeAdapter,bytes bridgeAdapterPayload)"
    );

  string public constant EMPTY_DECIMAL_STRING = "0.00000000";

  bytes32 public constant DELEGATED_KEY_AUTHORIZATION_MESSAGE_HASH =
    keccak256("Sign this free message to prove you control this wallet");

  // 1 hour
  uint256 public constant EXIT_FUND_WITHDRAW_DELAY_IN_S = 1 * 60 * 60;

  // 5 minutes
  uint256 public constant FIELD_UPGRADE_DELAY_IN_S = 5 * 60;

  // 8 hours
  uint64 public constant FUNDING_PERIOD_IN_MS = 8 * 60 * 60 * 1000;

  // 1 day
  uint256 public constant MAX_CHAIN_PROPAGATION_PERIOD_IN_S = 1 * 24 * 60 * 60;

  // 1 year
  uint256 public constant MAX_DELEGATE_KEY_EXPIRATION_PERIOD_IN_MS = 365 * 24 * 60 * 60 * 1000;

  // 5%
  uint64 public constant MAX_FEE_MULTIPLIER = 5 * 10 ** 6;

  // 1 year - value must be evenly divisible by `FUNDING_PERIOD_IN_MS`
  uint64 public constant MAX_FUNDING_TIME_PERIOD_PER_UPDATE_IN_MS = 365 * 24 * 60 * 60 * 1000;

  // Max int64
  uint64 public constant MAX_MAXIMUM_POSITION_SIZE = uint64(type(int64).max);

  uint256 public constant MAX_NUMBER_OF_MARKETS = type(uint8).max;

  // Positions smaller than this threshold will skip quote quantity validation for Position Below Minimum liquidations
  // and skip non-negative total quote validation Wallet Exits
  uint64 public constant MINIMUM_QUOTE_QUANTITY_VALIDATION_THRESHOLD = 10000;

  // To convert integer pips to a fractional price shift decimal left by the pip precision of 8
  // decimals places
  uint64 public constant PIP_PRICE_MULTIPLIER = 10 ** 8;

  string public constant QUOTE_ASSET_SYMBOL = "USD";

  uint8 public constant QUOTE_TOKEN_DECIMALS = 6;
}
