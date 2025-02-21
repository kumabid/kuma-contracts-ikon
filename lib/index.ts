import BigNumber from 'bignumber.js';
import { ethers } from 'ethers';

import { AssetDistributionStruct } from '../typechain-types/contracts/EarningsEscrow';
import {
  AcquisitionDeleverageArgumentsStruct,
  BalanceStruct,
  ClosureDeleverageArgumentsStruct,
  ExecuteTradeArgumentsStruct,
  IndexPricePayloadStruct,
  MarketStruct,
  NonceInvalidationStruct,
  TradeStruct,
  OrderStruct,
  OverridableMarketFieldsStruct,
  PositionBelowMinimumLiquidationArgumentsStruct,
  PositionInDeactivatedMarketLiquidationArgumentsStruct,
  TransferStruct,
  WalletLiquidationArgumentsStruct,
  WithdrawalStruct,
} from '../typechain-types/contracts/Exchange.sol/Exchange_v1';
import {
  WalletExitStruct,
  WalletStateStruct,
} from '../typechain-types/contracts/util/ExchangeWalletStateAggregator.sol/ExchangeWalletStateAggregator';

import * as contracts from './contracts';

export {
  AcquisitionDeleverageArgumentsStruct,
  AssetDistributionStruct,
  BalanceStruct,
  ClosureDeleverageArgumentsStruct,
  ExecuteTradeArgumentsStruct,
  IndexPricePayloadStruct,
  TradeStruct,
  MarketStruct,
  NonceInvalidationStruct,
  OrderStruct,
  OverridableMarketFieldsStruct,
  PositionBelowMinimumLiquidationArgumentsStruct,
  PositionInDeactivatedMarketLiquidationArgumentsStruct,
  TransferStruct,
  WalletExitStruct,
  WalletLiquidationArgumentsStruct,
  WalletStateStruct,
  WithdrawalStruct,
};

export { contracts };

export const exitFundWithdrawDelayInS = 7 * 24 * 60 * 60;

export const fieldUpgradeDelayInS = 1 * 24 * 60 * 60;

export const fundingPeriodLengthInMs = 8 * 60 * 60 * 1000;

/** The fixed number of digits following the decimal in quantities expressed as pips */
export const pipsDecimals = 8;

export const signatureHashVersion = '1.0.0-sandbox';

export enum OrderSelfTradePrevention {
  DecreaseAndCancel,
  CancelOldest,
  CancelNewest,
  CancelBoth,
}

export enum OrderSide {
  Buy,
  Sell,
}

export enum OrderTimeInForce {
  GTC,
  GTX,
  IOC,
  FOK,
}

export enum OrderType {
  Market,
  Limit,
  StopLossMarket,
  StopLossLimit,
  TakeProfitMarket,
  TakeProfitLimit,
  TrailingStop,
}

export enum OrderTriggerType {
  Last,
  Index,
}

export interface AssetDistribution {
  nonce: string;
  parentNonce: string;
  walletAddress: string;
  assetAddress: string;
  quantity: bigint;
}

export interface DelegatedKeyAuthorization {
  nonce: string;
  delegatedPublicKey: string;
  signature: string;
}

export interface SignedAssetDistribution extends AssetDistribution {
  exchangeSignature: string;
}

export interface Order {
  nonce: string;
  wallet: string;
  market: string;
  type: OrderType;
  side: OrderSide;
  quantity: string;
  price: string;
  triggerPrice?: string;
  triggerType?: OrderTriggerType;
  callbackRate?: string;
  conditionalOrderId?: string;
  isReduceOnly?: boolean;
  timeInForce?: OrderTimeInForce;
  selfTradePrevention?: OrderSelfTradePrevention;
  isLiquidationAcquisitionOnly?: boolean;
  delegatedPublicKey?: string;
  clientOrderId?: string;
}

export interface IndexPrice {
  baseAssetSymbol: string;
  timestampInMs: number;
  price: string; // Decimal string
  signature: string;
}

export interface Trade {
  baseAssetSymbol: string;
  baseQuantity: string;
  quoteQuantity: string;
  makerFeeQuantity: string;
  takerFeeQuantity: string;
  price: string; // Decimal string
  makerSide: OrderSide;
}

export interface Transfer {
  nonce: string;
  sourceWallet: string;
  destinationWallet: string;
  quantity: string; // Decimal string
}

export interface Withdrawal {
  nonce: string;
  wallet: string;
  quantity: string; // Decimal string
  maximumGasFee: string; // Decimal string
  bridgeAdapter: string;
  bridgeAdapterPayload: string;
}

export const hardhatChainId = 31337;

export const compareBaseAssetSymbols = (a: string, b: string): number =>
  Buffer.compare(
    ethers.getBytes(ethers.solidityPackedKeccak256(['string'], [a])),
    ethers.getBytes(ethers.solidityPackedKeccak256(['string'], [b])),
  );

export const decimalToAssetUnits = (
  decimal: string,
  decimals: number,
): string => pipsToAssetUnits(decimalToPips(decimal), decimals);

export const delegatedKeyAuthorizationMessage =
  'Sign this free message to prove you control this wallet';

/**
 * Convert decimal quantity string to integer pips as expected by contract structs. Truncates
 * anything beyond 8 decimals
 */
export const decimalToPips = (decimal: string): string =>
  new BigNumber(decimal)
    .shiftedBy(8)
    .integerValue(BigNumber.ROUND_DOWN)
    .toFixed(0);

export const getDomainSeparator = (
  contractAddress: string,
  chainId: number,
) => {
  return {
    name: 'Kuma',
    version: `${signatureHashVersion}`,
    chainId,
    verifyingContract: contractAddress,
  };
};

export const getDelegatedKeyAuthorizationSignatureTypedData = (
  delegatedKeyAuthorization: Omit<DelegatedKeyAuthorization, 'signature'>,
  contractAddress: string,
  chainId = hardhatChainId,
): Parameters<ethers.JsonRpcSigner['signTypedData']> => {
  return [
    getDomainSeparator(contractAddress, chainId),
    {
      DelegatedKeyAuthorization: [
        { name: 'nonce', type: 'uint128' },
        { name: 'delegatedPublicKey', type: 'address' },
        { name: 'message', type: 'string' },
      ],
    },
    {
      nonce: uuidToUint128(delegatedKeyAuthorization.nonce),
      delegatedPublicKey: delegatedKeyAuthorization.delegatedPublicKey,
      message: delegatedKeyAuthorizationMessage,
    },
  ];
};

export const getIndexPriceSignatureTypedData = (
  indexPrice: Omit<IndexPrice, 'signature'>,
  quoteAssetSymbol: string,
  contractAddress: string,
  chainId = hardhatChainId,
): Parameters<ethers.JsonRpcSigner['signTypedData']> => {
  return [
    getDomainSeparator(contractAddress, chainId),
    {
      IndexPrice: [
        { name: 'baseAssetSymbol', type: 'string' },
        { name: 'quoteAssetSymbol', type: 'string' },
        { name: 'timestampInMs', type: 'uint64' },
        { name: 'price', type: 'string' },
      ],
    },
    {
      baseAssetSymbol: indexPrice.baseAssetSymbol,
      quoteAssetSymbol,
      timestampInMs: indexPrice.timestampInMs,
      price: indexPrice.price,
    },
  ];
};

export const getOrderSignatureTypedData = (
  order: Order,
  contractAddress: string,
  chainId = hardhatChainId,
): Parameters<ethers.JsonRpcSigner['signTypedData']> => {
  const emptyPipString = '0.00000000';

  return [
    getDomainSeparator(contractAddress, chainId),
    {
      Order: [
        { name: 'nonce', type: 'uint128' },
        { name: 'wallet', type: 'address' },
        { name: 'marketSymbol', type: 'string' },
        { name: 'orderType', type: 'uint8' },
        { name: 'orderSide', type: 'uint8' },
        { name: 'quantity', type: 'string' },
        { name: 'limitPrice', type: 'string' },
        { name: 'triggerPrice', type: 'string' },
        { name: 'triggerType', type: 'uint8' },
        { name: 'callbackRate', type: 'string' },
        { name: 'conditionalOrderId', type: 'uint128' },
        { name: 'isReduceOnly', type: 'bool' },
        { name: 'timeInForce', type: 'uint8' },
        { name: 'selfTradePrevention', type: 'uint8' },
        { name: 'isLiquidationAcquisitionOnly', type: 'bool' },
        { name: 'delegatedPublicKey', type: 'address' },
        { name: 'clientOrderId', type: 'string' },
      ],
    },
    {
      nonce: uuidToUint128(order.nonce),
      wallet: order.wallet,
      marketSymbol: order.market,
      orderType: order.type,
      orderSide: order.side,
      quantity: order.quantity,
      limitPrice: order.price || emptyPipString,
      triggerPrice: order.triggerPrice || emptyPipString,
      triggerType: order.triggerType || 0,
      callbackRate: order.callbackRate || emptyPipString,
      conditionalOrderId: order.conditionalOrderId
        ? uuidToUint128(order.conditionalOrderId)
        : '0',
      isReduceOnly: !!order.isReduceOnly,
      timeInForce: order.timeInForce || 0,
      selfTradePrevention: order.selfTradePrevention || 0,
      isLiquidationAcquisitionOnly: !!order.isLiquidationAcquisitionOnly,
      delegatedPublicKey: order.delegatedPublicKey || ethers.ZeroAddress,
      clientOrderId: order.clientOrderId || '',
    },
  ];
};

export const getStakingDistributionHash = (
  escrowAddress: string,
  distribution: AssetDistribution,
): string => {
  return solidityHashOfParams([
    ['address', escrowAddress],
    ['uint128', uuidToUint128(distribution.nonce)],
    ['uint128', uuidToUint128(distribution.parentNonce)],
    ['address', distribution.walletAddress],
    ['address', distribution.assetAddress],
    ['uint256', distribution.quantity],
  ]);
};

export const getTransferSignatureTypedData = (
  transfer: Transfer,
  contractAddress: string,
  chainId = hardhatChainId,
): Parameters<ethers.JsonRpcSigner['signTypedData']> => {
  return [
    getDomainSeparator(contractAddress, chainId),
    {
      Transfer: [
        { name: 'nonce', type: 'uint128' },
        { name: 'sourceWallet', type: 'address' },
        { name: 'destinationWallet', type: 'address' },
        { name: 'quantity', type: 'string' },
      ],
    },
    {
      nonce: uuidToUint128(transfer.nonce),
      sourceWallet: transfer.sourceWallet,
      destinationWallet: transfer.destinationWallet,
      quantity: transfer.quantity,
    },
  ];
};

export const getWithdrawalSignatureTypedData = (
  withdrawal: Withdrawal,
  contractAddress: string,
  chainId = hardhatChainId,
): Parameters<ethers.JsonRpcSigner['signTypedData']> => {
  return [
    getDomainSeparator(contractAddress, chainId),
    {
      Withdrawal: [
        { name: 'nonce', type: 'uint128' },
        { name: 'wallet', type: 'address' },
        { name: 'quantity', type: 'string' },
        { name: 'maximumGasFee', type: 'string' },
        { name: 'bridgeAdapter', type: 'address' },
        { name: 'bridgeAdapterPayload', type: 'bytes' },
      ],
    },
    {
      nonce: uuidToUint128(withdrawal.nonce),
      wallet: withdrawal.wallet,
      quantity: withdrawal.quantity,
      maximumGasFee: withdrawal.maximumGasFee,
      bridgeAdapter: withdrawal.bridgeAdapter,
      bridgeAdapterPayload: withdrawal.bridgeAdapterPayload,
    },
  ];
};

export const getPublishFundingMutiplierArguments = (
  baseAssetSymbol: string,
  fundingRate: string,
): [string, string] => {
  return [baseAssetSymbol, decimalToPips(fundingRate)];
};

export const getExecuteTradeArguments = (
  buyOrder: Order,
  buyWalletSignature: string,
  sellOrder: Order,
  sellWalletSignature: string,
  trade: Trade,
  buyDelegatedKeyAuthorization?: DelegatedKeyAuthorization,
  sellDelegatedKeyAuthorization?: DelegatedKeyAuthorization,
): [ExecuteTradeArgumentsStruct] => {
  return [
    {
      buy: orderToArgumentStruct(
        buyOrder,
        buyWalletSignature,
        buyDelegatedKeyAuthorization,
      ),
      sell: orderToArgumentStruct(
        sellOrder,
        sellWalletSignature,
        sellDelegatedKeyAuthorization,
      ),
      trade: tradeToArgumentStruct(trade, buyOrder),
    },
  ];
};

export const getStakingEscrowDistributeArguments = (
  distribution: SignedAssetDistribution,
): [AssetDistributionStruct] => {
  return [
    {
      nonce: uuidToHexString(distribution.nonce),
      parentNonce: uuidToHexString(distribution.parentNonce),
      walletAddress: distribution.walletAddress,
      assetAddress: distribution.assetAddress,
      quantity: distribution.quantity,
      exchangeSignature: distribution.exchangeSignature,
    },
  ];
};

export const getTransferArguments = (
  transfer: Transfer,
  gasFee: string,
  walletSignature: string,
): [TransferStruct] => {
  return [
    {
      nonce: uuidToHexString(transfer.nonce),
      sourceWallet: transfer.sourceWallet,
      destinationWallet: transfer.destinationWallet,
      grossQuantity: decimalToPips(transfer.quantity),
      gasFee: decimalToPips(gasFee),
      walletSignature,
    },
  ];
};

export const getWithdrawArguments = (
  withdrawal: Withdrawal,
  gasFee: string,
  walletSignature: string,
): [WithdrawalStruct] => {
  return [
    {
      nonce: uuidToHexString(withdrawal.nonce),
      wallet: withdrawal.wallet,
      grossQuantity: decimalToPips(withdrawal.quantity),
      maximumGasFee: decimalToPips(withdrawal.maximumGasFee),
      bridgeAdapter: withdrawal.bridgeAdapter,
      bridgeAdapterPayload: withdrawal.bridgeAdapterPayload,
      gasFee: decimalToPips(gasFee),
      walletSignature,
    },
  ];
};

export const indexPriceToArgumentStruct = (
  indexPriceAdapter: string,
  indexPrice: IndexPrice,
): IndexPricePayloadStruct => {
  return {
    indexPriceAdapter,
    payload: indexPriceToArgumentPayload(indexPrice),
  };
};

export const indexPriceToArgumentPayload = (indexPrice: IndexPrice): string => {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(string,uint64,uint64)', 'bytes'],
    [
      [
        indexPrice.baseAssetSymbol,
        indexPrice.timestampInMs,
        decimalToPips(indexPrice.price),
      ],
      indexPrice.signature,
    ],
  );
};

/**
 * Convert pips to native token quantity, taking the nunmber of decimals into account
 */
export const pipsToAssetUnits = (pips: string, decimals: number): string =>
  new BigNumber(pips)
    .shiftedBy(decimals - 8) // This is still correct when decimals < 8
    .integerValue(BigNumber.ROUND_DOWN)
    .toFixed(0);

export const uuidToHexString = (uuid: string): string =>
  `0x${uuid.replace(/-/g, '')}`;

const orderToArgumentStruct = (
  o: Order,
  walletSignature: string,
  delegatedKeyAuthorization?: DelegatedKeyAuthorization,
) => {
  const emptyPipString = '0.00000000';

  return {
    nonce: uuidToHexString(o.nonce),
    wallet: o.wallet,
    orderType: o.type,
    side: o.side,
    quantity: decimalToPips(o.quantity),
    limitPrice: decimalToPips(o.price || emptyPipString),
    triggerPrice: decimalToPips(o.triggerPrice || emptyPipString),
    triggerType: o.triggerType || 0,
    callbackRate: decimalToPips(o.callbackRate || emptyPipString),
    conditionalOrderId: o.conditionalOrderId || 0,
    clientOrderId: o.clientOrderId || '',
    isReduceOnly: !!o.isReduceOnly,
    timeInForce: o.timeInForce || 0,
    selfTradePrevention: o.selfTradePrevention || 0,
    isLiquidationAcquisitionOnly: !!o.isLiquidationAcquisitionOnly,
    walletSignature,
    isSignedByDelegatedKey: !!delegatedKeyAuthorization,
    delegatedKeyAuthorization: delegatedKeyAuthorization
      ? {
          nonce: uuidToHexString(delegatedKeyAuthorization.nonce),
          delegatedPublicKey: delegatedKeyAuthorization.delegatedPublicKey,
          signature: delegatedKeyAuthorization.signature,
        }
      : {
          nonce: 0,
          delegatedPublicKey: ethers.ZeroAddress,
          signature: '0x',
        },
  };
};

type TypeValuePair =
  | ['string' | 'address', string]
  | ['uint256' | 'uint128', bigint]
  | ['uint8' | 'uint64', number]
  | ['bool', boolean];

const solidityHashOfParams = (params: TypeValuePair[]): string => {
  const fields = params.map((param) => param[0]);
  const values = params.map((param) => param[1]);
  return ethers.solidityPackedKeccak256(fields, values);
};

const tradeToArgumentStruct = (t: Trade, order: Order) => {
  return {
    baseAssetSymbol: order.market.split('-')[0],
    quoteAssetSymbol: order.market.split('-')[1],
    baseQuantity: decimalToPips(t.baseQuantity),
    quoteQuantity: decimalToPips(t.quoteQuantity),
    makerFeeQuantity: decimalToPips(t.makerFeeQuantity),
    takerFeeQuantity: decimalToPips(t.takerFeeQuantity),
    price: decimalToPips(t.price),
    makerSide: t.makerSide,
  };
};

const uuidToUint128 = (uuid: string): bigint =>
  BigInt.asUintN(128, BigInt(uuidToHexString(uuid)));
