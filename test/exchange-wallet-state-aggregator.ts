import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { v1 as uuidv1 } from 'uuid';
import { ethers, network } from 'hardhat';

import {
  baseAssetSymbol,
  buildIndexPrice,
  deployAndAssociateContracts,
  expect,
  fundWallets,
  quoteAssetSymbol,
} from './helpers';
import {
  getExecuteTradeArguments,
  getOrderSignatureTypedData,
  indexPriceToArgumentStruct,
  Order,
  OrderSide,
  OrderType,
  Trade,
} from '../lib';
import type {
  Exchange_v1,
  KumaIndexAndOraclePriceAdapter,
  USDC,
} from '../typechain-types';

describe('Exchange', function () {
  let buyOrder: Order;
  let buyOrderSignature: string;
  let dispatcherWallet: SignerWithAddress;
  let exchange: Exchange_v1;
  let exitFundWallet: SignerWithAddress;
  let indexPriceAdapter: KumaIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let insuranceFundWallet: SignerWithAddress;
  let ownerWallet: SignerWithAddress;
  let sellOrder: Order;
  let sellOrderSignature: string;
  let trade: Trade;
  let trader1Wallet: SignerWithAddress;
  let trader2Wallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    const wallets = await ethers.getSigners();

    const [feeWallet] = wallets;
    [
      ,
      dispatcherWallet,
      exitFundWallet,
      indexPriceServiceWallet,
      insuranceFundWallet,
      ownerWallet,
      trader1Wallet,
      trader2Wallet,
    ] = wallets;
    const results = await deployAndAssociateContracts(
      ownerWallet,
      dispatcherWallet,
      exitFundWallet,
      feeWallet,
      indexPriceServiceWallet,
      insuranceFundWallet,
    );
    exchange = results.exchange;
    indexPriceAdapter = results.indexPriceAdapter;
    usdc = results.usdc;

    await usdc.faucet(dispatcherWallet.address);

    await fundWallets(
      [trader1Wallet, trader2Wallet],
      dispatcherWallet,
      exchange,
      results.usdc,
    );

    await exchange
      .connect(dispatcherWallet)
      .publishIndexPrices([
        indexPriceToArgumentStruct(
          await indexPriceAdapter.getAddress(),
          await buildIndexPrice(
            await exchange.getAddress(),
            indexPriceServiceWallet,
          ),
        ),
      ]);

    buyOrder = {
      nonce: uuidv1(),
      wallet: trader2Wallet.address,
      market: `${baseAssetSymbol}-USD`,
      type: OrderType.Limit,
      side: OrderSide.Buy,
      quantity: '10.00000000',
      price: '2000.00000000',
    };
    buyOrderSignature = await trader2Wallet.signTypedData(
      ...getOrderSignatureTypedData(buyOrder, await exchange.getAddress()),
    );

    sellOrder = {
      nonce: uuidv1(),
      wallet: trader1Wallet.address,
      market: `${baseAssetSymbol}-USD`,
      type: OrderType.Limit,
      side: OrderSide.Sell,
      quantity: '10.00000000',
      price: '2000.00000000',
    };
    sellOrderSignature = await trader1Wallet.signTypedData(
      ...getOrderSignatureTypedData(sellOrder, await exchange.getAddress()),
    );

    trade = {
      baseAssetSymbol: baseAssetSymbol,
      baseQuantity: '10.00000000',
      quoteQuantity: '20000.00000000',
      makerFeeQuantity: '20.00000000',
      takerFeeQuantity: '40.00000000',
      price: '2000.00000000',
      makerSide: OrderSide.Sell,
    };
  });

  describe('loadWalletStates', () => {
    it('should work', async function () {
      await exchange
        .connect(dispatcherWallet)
        .executeTrade(
          ...getExecuteTradeArguments(
            buyOrder,
            buyOrderSignature,
            sellOrder,
            sellOrderSignature,
            trade,
          ),
        );

      const aggregator = await (
        await ethers.getContractFactory('ExchangeWalletStateAggregator')
      ).deploy(await exchange.getAddress());

      const results = await aggregator.loadWalletStates([
        trader1Wallet.address,
        trader2Wallet.address,
      ]);

      expect(results).to.be.an('array').with.length(2);

      expect(results[0].balances).to.be.an('array').with.length(2);
      expect(results[0].balances[0].balance).to.equal(
        await exchange.loadBalanceBySymbol(
          trader1Wallet.address,
          quoteAssetSymbol,
        ),
      );
      expect(results[0].balances[1].balance).to.equal(
        await exchange.loadBalanceBySymbol(
          trader1Wallet.address,
          baseAssetSymbol,
        ),
      );

      expect(results[1].balances[0].balance).to.equal(
        await exchange.loadBalanceBySymbol(
          trader2Wallet.address,
          quoteAssetSymbol,
        ),
      );
      expect(results[1].balances[1].balance).to.equal(
        await exchange.loadBalanceBySymbol(
          trader2Wallet.address,
          baseAssetSymbol,
        ),
      );
    });
  });
});
