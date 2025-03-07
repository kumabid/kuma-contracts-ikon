import { time } from '@nomicfoundation/hardhat-network-helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { v1 as uuidv1 } from 'uuid';
import { ethers, network } from 'hardhat';

import {
  addAndActivateMarket,
  baseAssetSymbol,
  buildIndexPrice,
  buildIndexPriceWithValue,
  deployAndAssociateContracts,
  deployLibraryContracts,
  executeTrade,
  expect,
  fundWallets,
  quoteAssetDecimals,
  quoteAssetSymbol,
} from './helpers';
import {
  decimalToPips,
  fieldUpgradeDelayInS,
  fundingPeriodLengthInMs,
  getDelegatedKeyAuthorizationSignatureTypedData,
  getExecuteTradeArguments,
  getOrderSignatureTypedData,
  indexPriceToArgumentStruct,
  Order,
  OrderSide,
  OrderTimeInForce,
  OrderTriggerType,
  OrderType,
  Trade,
  uuidToHexString,
} from '../lib';
import type {
  ChainlinkAggregatorMock,
  Custodian,
  Exchange_v1,
  Governance,
  KumaIndexAndOraclePriceAdapter,
  USDC,
} from '../typechain-types';
import { increase } from '@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time';

describe('Exchange with balance migration source', function () {
  let buyOrder: Order;
  let buyOrderSignature: string;
  let chainlinkAggregator: ChainlinkAggregatorMock;
  let custodian: Custodian;
  let dispatcherWallet: SignerWithAddress;
  let exchange: Exchange_v1;
  let exitFundWallet: SignerWithAddress;
  let feeWallet: SignerWithAddress;
  let governance: Governance;
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

    [
      dispatcherWallet,
      exitFundWallet,
      feeWallet,
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
      0,
      true,
      ethers.ZeroAddress,
      ['ETH', 'BTC'],
    );
    chainlinkAggregator = results.chainlinkAggregator;
    custodian = results.custodian;
    exchange = results.exchange;
    governance = results.governance;
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
      quantity: '5.00000000',
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
      quantity: '5.00000000',
      price: '2000.00000000',
    };
    sellOrderSignature = await trader1Wallet.signTypedData(
      ...getOrderSignatureTypedData(sellOrder, await exchange.getAddress()),
    );

    trade = {
      baseAssetSymbol,
      baseQuantity: '5.00000000',
      quoteQuantity: '10000.00000000',
      makerFeeQuantity: '10.00000000',
      takerFeeQuantity: '20.00000000',
      price: '2000.00000000',
      makerSide: OrderSide.Sell,
    };
  });

  describe('executeTrade', () => {
    it('should work for limit orders with maker sell with migrated open positions with outstanding funding payments', async function () {
      // Open positions //

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

      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader2Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('5.00000000'));

      expect(
        (
          await exchange.loadBalanceStructBySymbol(
            trader1Wallet.address,
            baseAssetSymbol,
          )
        ).balance.toString(),
      ).to.equal(decimalToPips('-5.00000000'));

      // Publish funding multipliers //

      await increase((fundingPeriodLengthInMs * 3) / 1000);
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
      await exchange
        .connect(dispatcherWallet)
        .publishFundingMultiplier(baseAssetSymbol, decimalToPips('0.00005000'));

      // Apply funding to positons //

      await exchange.applyOutstandingWalletFundingForMarket(
        trader1Wallet.address,
        baseAssetSymbol,
      );
      await exchange.applyOutstandingWalletFundingForMarket(
        trader2Wallet.address,
        baseAssetSymbol,
      );

      // Deploy new Exchange contract //

      const oraclePriceAdapter = await (
        await (await ethers.getContractFactory('ChainlinkOraclePriceAdapter'))
          .connect(ownerWallet)
          .deploy([baseAssetSymbol], [await chainlinkAggregator.getAddress()])
      ).waitForDeployment();
      const newIndexPriceAdapter = await (
        await (
          await ethers.getContractFactory('KumaIndexAndOraclePriceAdapter')
        )
          .connect(ownerWallet)
          .deploy(ownerWallet.address, [indexPriceServiceWallet.address])
      ).waitForDeployment();
      const newExchange = await (
        await (await deployLibraryContracts())
          .connect(ownerWallet)
          .deploy(
            await exchange.getAddress(),
            exitFundWallet.address,
            feeWallet.address,
            [await newIndexPriceAdapter.getAddress()],
            insuranceFundWallet.address,
            await oraclePriceAdapter.getAddress(),
            await usdc.getAddress(),
          )
      ).waitForDeployment();
      await newIndexPriceAdapter.setActive(await newExchange.getAddress());

      // Upgrade to new Exchange //

      await governance.initiateExchangeUpgrade(await newExchange.getAddress());
      await governance.finalizeExchangeUpgrade(await newExchange.getAddress());
      await Promise.all([
        (
          await newExchange.setCustodian(await custodian.getAddress(), [])
        ).wait(),
        (await newExchange.setDepositIndex()).wait(),
        (await newExchange.setDepositEnabled(true)).wait(),
        (await newExchange.setDispatcher(dispatcherWallet.address)).wait(),
      ]);

      await increase((fundingPeriodLengthInMs * 5) / 1000);
      // await addAndActivateMarket(dispatcherWallet, newExchange);
      await newExchange.addMarket({
        exists: true,
        isActive: false,
        baseAssetSymbol,
        indexPriceAtDeactivation: 0,
        lastIndexPrice: 0,
        lastIndexPriceTimestampInMs: 0,
        overridableFields: {
          initialMarginFraction: '5000000',
          maintenanceMarginFraction: '3000000',
          incrementalInitialMarginFraction: '1000000',
          baselinePositionSize: '14000000000',
          incrementalPositionSize: '2800000000',
          maximumPositionSize: '282000000000',
          minimumPositionSize: '10000000',
        },
      });

      expect(
        (
          await newExchange.loadBalanceBySymbol(
            trader2Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('5.00000000'));

      expect(
        (
          await newExchange.loadBalanceStructBySymbol(
            trader1Wallet.address,
            baseAssetSymbol,
          )
        ).balance.toString(),
      ).to.equal(decimalToPips('-5.00000000'));

      buyOrder.nonce = uuidv1();
      buyOrderSignature = await trader2Wallet.signTypedData(
        ...getOrderSignatureTypedData(buyOrder, await newExchange.getAddress()),
      );
      sellOrder.nonce = uuidv1();
      sellOrderSignature = await trader1Wallet.signTypedData(
        ...getOrderSignatureTypedData(
          sellOrder,
          await newExchange.getAddress(),
        ),
      );
      await newExchange
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

      expect(
        (
          await newExchange.loadBalanceBySymbol(
            trader2Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('10.00000000'));

      expect(
        (
          await newExchange.loadBalanceStructBySymbol(
            trader1Wallet.address,
            baseAssetSymbol,
          )
        ).balance.toString(),
      ).to.equal(decimalToPips('-10.00000000'));

      buyOrder.nonce = uuidv1();
      buyOrderSignature = await trader2Wallet.signTypedData(
        ...getOrderSignatureTypedData(buyOrder, await newExchange.getAddress()),
      );
      sellOrder.nonce = uuidv1();
      sellOrderSignature = await trader1Wallet.signTypedData(
        ...getOrderSignatureTypedData(
          sellOrder,
          await newExchange.getAddress(),
        ),
      );
      await newExchange
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
    });

    it.only('should work for limit orders with maker sell with migrated open positions in multiple markets', async function () {
      // Open positions //

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

      await addAndActivateMarket(dispatcherWallet, exchange, 'BTC');
      await fundWallets(
        [trader1Wallet, trader2Wallet],
        dispatcherWallet,
        exchange,
        usdc,
        '12000.00000000',
      );

      await executeTrade(
        exchange,
        dispatcherWallet,
        await buildIndexPriceWithValue(
          await exchange.getAddress(),
          indexPriceServiceWallet,
          '24000.00000000',
          'BTC',
        ),
        await indexPriceAdapter.getAddress(),
        trader1Wallet,
        trader2Wallet,
        'BTC',
        '24000.00000000',
      );

      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader2Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('5.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(trader2Wallet.address, 'BTC')
        ).toString(),
      ).to.equal(decimalToPips('10.00000000'));

      expect(
        (
          await exchange.loadBalanceStructBySymbol(
            trader1Wallet.address,
            baseAssetSymbol,
          )
        ).balance.toString(),
      ).to.equal(decimalToPips('-5.00000000'));
      expect(
        (
          await exchange.loadBalanceBySymbol(trader1Wallet.address, 'BTC')
        ).toString(),
      ).to.equal(decimalToPips('-10.00000000'));

      // Deploy new Exchange contract //

      const oraclePriceAdapter = await (
        await (await ethers.getContractFactory('ChainlinkOraclePriceAdapter'))
          .connect(ownerWallet)
          .deploy(
            [baseAssetSymbol, 'BTC'],
            [
              await chainlinkAggregator.getAddress(),
              await chainlinkAggregator.getAddress(),
            ],
          )
      ).waitForDeployment();
      const newIndexPriceAdapter = await (
        await (
          await ethers.getContractFactory('KumaIndexAndOraclePriceAdapter')
        )
          .connect(ownerWallet)
          .deploy(ownerWallet.address, [indexPriceServiceWallet.address])
      ).waitForDeployment();
      const newExchange = await (
        await (await deployLibraryContracts())
          .connect(ownerWallet)
          .deploy(
            await exchange.getAddress(),
            exitFundWallet.address,
            feeWallet.address,
            [await newIndexPriceAdapter.getAddress()],
            insuranceFundWallet.address,
            await oraclePriceAdapter.getAddress(),
            await usdc.getAddress(),
          )
      ).waitForDeployment();
      await newIndexPriceAdapter.setActive(await newExchange.getAddress());

      // Upgrade to new Exchange //

      await governance.initiateExchangeUpgrade(await newExchange.getAddress());
      await governance.finalizeExchangeUpgrade(await newExchange.getAddress());
      await Promise.all([
        (
          await newExchange.setCustodian(await custodian.getAddress(), [])
        ).wait(),
        (await newExchange.setDepositIndex()).wait(),
        (await newExchange.setDepositEnabled(true)).wait(),
        (await newExchange.setDispatcher(dispatcherWallet.address)).wait(),
      ]);

      await newExchange.addMarket({
        exists: true,
        isActive: false,
        baseAssetSymbol,
        indexPriceAtDeactivation: 0,
        lastIndexPrice: 0,
        lastIndexPriceTimestampInMs: 0,
        overridableFields: {
          initialMarginFraction: '5000000',
          maintenanceMarginFraction: '3000000',
          incrementalInitialMarginFraction: '1000000',
          baselinePositionSize: '14000000000',
          incrementalPositionSize: '2800000000',
          maximumPositionSize: '282000000000',
          minimumPositionSize: '10000000',
        },
      });
      await newExchange.addMarket({
        exists: true,
        isActive: false,
        baseAssetSymbol: 'BTC',
        indexPriceAtDeactivation: 0,
        lastIndexPrice: 0,
        lastIndexPriceTimestampInMs: 0,
        overridableFields: {
          initialMarginFraction: '5000000',
          maintenanceMarginFraction: '3000000',
          incrementalInitialMarginFraction: '1000000',
          baselinePositionSize: '14000000000',
          incrementalPositionSize: '2800000000',
          maximumPositionSize: '282000000000',
          minimumPositionSize: '10000000',
        },
      });

      expect(
        (
          await newExchange.loadBalanceBySymbol(
            trader2Wallet.address,
            baseAssetSymbol,
          )
        ).toString(),
      ).to.equal(decimalToPips('5.00000000'));
      expect(
        (
          await newExchange.loadBalanceBySymbol(trader2Wallet.address, 'BTC')
        ).toString(),
      ).to.equal(decimalToPips('10.00000000'));

      expect(
        (
          await newExchange.loadBalanceStructBySymbol(
            trader1Wallet.address,
            baseAssetSymbol,
          )
        ).balance.toString(),
      ).to.equal(decimalToPips('-5.00000000'));
      expect(
        (
          await newExchange.loadBalanceBySymbol(trader1Wallet.address, 'BTC')
        ).toString(),
      ).to.equal(decimalToPips('-10.00000000'));

      buyOrder.nonce = uuidv1();
      buyOrderSignature = await trader2Wallet.signTypedData(
        ...getOrderSignatureTypedData(buyOrder, await newExchange.getAddress()),
      );
      sellOrder.nonce = uuidv1();
      sellOrderSignature = await trader1Wallet.signTypedData(
        ...getOrderSignatureTypedData(
          sellOrder,
          await newExchange.getAddress(),
        ),
      );

      await newExchange
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
    });
  });
});
