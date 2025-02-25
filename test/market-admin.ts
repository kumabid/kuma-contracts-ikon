import BigNumber from 'bignumber.js';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers, network } from 'hardhat';

import {
  ChainlinkOraclePriceAdapter,
  Exchange_v1,
  Exchange_v1__factory,
  Governance,
  KumaIndexAndOraclePriceAdapter,
  type KumaIndexAndOraclePriceAdapter__factory,
  USDC,
} from '../typechain-types';
import type { MarketStruct } from '../typechain-types/contracts/Exchange.sol/Exchange_v1';
import {
  baseAssetSymbol,
  buildIndexPrice,
  buildIndexPriceWithTimestamp,
  deployAndAssociateContracts,
  getLatestBlockTimestampInSeconds,
  quoteAssetSymbol,
} from './helpers';
import { decimalToPips, indexPriceToArgumentStruct } from '../lib';

describe('Exchange', function () {
  let exchange: Exchange_v1;
  let ExchangeFactory: Exchange_v1__factory;
  let governance: Governance;
  let KumaIndexAndOraclePriceAdapterFactory: KumaIndexAndOraclePriceAdapter__factory;
  let indexPriceAdapter: KumaIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let marketStruct: MarketStruct;
  let ownerWallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    [ownerWallet] = await ethers.getSigners();
    const results = await deployAndAssociateContracts(
      ownerWallet,
      ownerWallet,
      ownerWallet,
      ownerWallet,
      ownerWallet,
      ownerWallet,
      0,
      true,
      ethers.ZeroAddress,
      [baseAssetSymbol, 'XYZ'],
    );
    ExchangeFactory = results.ExchangeFactory;
    exchange = results.exchange;
    governance = results.governance;
    KumaIndexAndOraclePriceAdapterFactory = await ethers.getContractFactory(
      'KumaIndexAndOraclePriceAdapter',
    );
    indexPriceAdapter = results.indexPriceAdapter;
    indexPriceServiceWallet = ownerWallet;
    marketStruct = {
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
    };
    usdc = results.usdc;
  });

  describe('activateMarket', async function () {
    it('should work', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      await exchange.addMarket(marketStruct);
      await exchange.activateMarket('XYZ');

      const events = await exchange.queryFilter(
        exchange.filters.MarketActivated(),
      );
      expect(events).to.have.lengthOf(2);
      expect(events[1].args?.baseAssetSymbol).to.equal('XYZ');
    });

    it('should revert when not called by dispatcher wallet', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .activateMarket(marketStruct.baseAssetSymbol),
      ).to.eventually.be.rejectedWith(/caller must be dispatcher wallet/i);
    });

    it('should revert when market already active', async () => {
      await expect(
        exchange.activateMarket(marketStruct.baseAssetSymbol),
      ).to.eventually.be.rejectedWith(/no inactive market found/i);
    });
  });

  describe('addMarket', async function () {
    it('should work', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      await exchange.addMarket(marketStruct);

      const events = await exchange.queryFilter(exchange.filters.MarketAdded());
      expect(events).to.have.lengthOf(2);
      expect(events[1].args?.baseAssetSymbol).to.equal('XYZ');
    });

    it('should migrate active state from balance migration source', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      await exchange.addMarket(marketStruct);
      await exchange.activateMarket('XYZ');

      indexPriceAdapter = await KumaIndexAndOraclePriceAdapterFactory.deploy(
        ownerWallet.address,
        [indexPriceServiceWallet.address],
      );
      const newExchange = await ExchangeFactory.deploy(
        await exchange.getAddress(),
        ownerWallet.address,
        ownerWallet.address,
        [await indexPriceAdapter.getAddress()],
        ownerWallet.address,
        await indexPriceAdapter.getAddress(),
        await usdc.getAddress(),
      );
      await governance.initiateExchangeUpgrade(await newExchange.getAddress());
      await governance.finalizeExchangeUpgrade(await newExchange.getAddress());

      await newExchange.addMarket(marketStruct);
      const market = await newExchange.loadMarket(0);
      expect(market.isActive).to.equal(true);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(/caller must be admin wallet/i);
    });

    it('should revert when max number of markets reached', async () => {
      const { exchange, oraclePriceAdapter } =
        await deployAndAssociateContracts(ownerWallet);
      const ChainlinkAggregatorMockFactory = await ethers.getContractFactory(
        'ChainlinkAggregatorMock',
      );

      for (let i = 0; i < 254; i += 1) {
        const aggregator = await ChainlinkAggregatorMockFactory.deploy();
        await aggregator.setPrice(200000);

        await (
          oraclePriceAdapter as ChainlinkOraclePriceAdapter
        ).addBaseAssetSymbolAndAggregator(
          `XYZ${i}`,
          await aggregator.getAddress(),
        );
        await exchange.addMarket({
          ...marketStruct,
          baseAssetSymbol: `XYZ${i}`,
        });
      }

      await expect(
        exchange.addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(/max number of markets reached/i);
    });

    it('should revert for existing base asset symbol', async () => {
      await expect(
        exchange.addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(/market already exists/i);
    });

    it('should revert when using quote asset symbol as base asset symbol', async () => {
      await expect(
        exchange.addMarket({
          ...marketStruct,
          baseAssetSymbol: quoteAssetSymbol,
        }),
      ).to.eventually.be.rejectedWith(
        /base asset symbol cannot be same as quote/i,
      );
    });

    it('should revert for invalid initial margin fraction', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      marketStruct.overridableFields.initialMarginFraction = '1';
      await expect(
        exchange.addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(/initial margin fraction below min/i);
    });

    it('should revert for invalid maintenance margin fraction', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      marketStruct.overridableFields.maintenanceMarginFraction = '1';
      await expect(
        exchange.addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(/maintenance margin fraction below min/i);
    });

    it('should revert for invalid incremental initial margin fraction', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      marketStruct.overridableFields.incrementalInitialMarginFraction = '1';
      await expect(
        exchange.addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(
        /incremental initial margin fraction below min/i,
      );
    });

    it('should revert for invalid incremental position size', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      marketStruct.overridableFields.incrementalPositionSize = '0';
      await expect(
        exchange.addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(
        /incremental position size cannot be zero/i,
      );
    });

    it('should revert for invalid baseline position size', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      marketStruct.overridableFields.baselinePositionSize = new BigNumber(2)
        .pow(63)
        .toString();
      await expect(
        exchange.addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(/baseline position size exceeds max/i);
    });

    it('should revert for invalid maximum position size', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      marketStruct.overridableFields.maximumPositionSize = new BigNumber(2)
        .pow(63)
        .toString();
      await expect(
        exchange.addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(/maximum position size exceeds max/i);
    });

    it('should revert for invalid minimum position size', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      marketStruct.overridableFields.minimumPositionSize = new BigNumber(2)
        .pow(63)
        .minus(1)
        .toString();
      await expect(
        exchange.addMarket(marketStruct),
      ).to.eventually.be.rejectedWith(/minimum position size exceeds max/i);
    });
  });

  describe('deactivateMarket', async function () {
    it('should work', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      await exchange.addMarket(marketStruct);
      await exchange.activateMarket('XYZ');
      await exchange.deactivateMarket('XYZ');

      const events = await exchange.queryFilter(
        exchange.filters.MarketDeactivated(),
      );
      expect(events).to.have.lengthOf(1);
      expect(events[0].args?.baseAssetSymbol).to.equal('XYZ');
    });

    it('should revert when not called by dispatcher', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .deactivateMarket(baseAssetSymbol),
      ).to.eventually.be.rejectedWith(/caller must be dispatcher wallet/i);
    });

    it('should revert when market does not exist', async () => {
      await expect(
        exchange.deactivateMarket('XYZ'),
      ).to.eventually.be.rejectedWith(/no active market found/i);
    });
  });

  describe('publishIndexPrices', async function () {
    it('should work', async () => {
      marketStruct.baseAssetSymbol = 'XYZ';
      await exchange.addMarket(marketStruct);
      await exchange.activateMarket('XYZ');

      const indexPrice = await buildIndexPrice(
        await exchange.getAddress(),
        indexPriceServiceWallet,
      );
      const indexPrice2 = await buildIndexPrice(
        await exchange.getAddress(),
        indexPriceServiceWallet,
        'XYZ',
      );

      await exchange.publishIndexPrices([
        indexPriceToArgumentStruct(
          await indexPriceAdapter.getAddress(),
          indexPrice,
        ),
        indexPriceToArgumentStruct(
          await indexPriceAdapter.getAddress(),
          indexPrice2,
        ),
      ]);

      const events = await exchange.queryFilter(
        exchange.filters.IndexPricePublished(),
      );
      expect(events).to.have.lengthOf(2);
      expect(events[0].args?.baseAssetSymbol).to.equal(
        indexPrice.baseAssetSymbol,
      );
      expect(events[0].args?.timestampInMs).to.equal(indexPrice.timestampInMs);
      expect(events[0].args?.price).to.equal(decimalToPips(indexPrice.price));
      expect(events[1].args?.baseAssetSymbol).to.equal(
        indexPrice2.baseAssetSymbol,
      );
      expect(events[1].args?.timestampInMs).to.equal(indexPrice2.timestampInMs);
      expect(events[1].args?.price).to.equal(decimalToPips(indexPrice2.price));
    });

    it('should revert when not called by dispatcher', async () => {
      const indexPrice = await buildIndexPrice(
        await exchange.getAddress(),
        indexPriceServiceWallet,
      );
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .publishIndexPrices([
            indexPriceToArgumentStruct(
              await indexPriceAdapter.getAddress(),
              indexPrice,
            ),
          ]),
      ).to.eventually.be.rejectedWith(/caller must be dispatcher wallet/i);
    });

    it('should revert when market not found', async () => {
      const indexPrice = await buildIndexPrice(
        await exchange.getAddress(),
        indexPriceServiceWallet,
        'XYZ',
      );

      await expect(
        exchange.publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            indexPrice,
          ),
        ]),
      ).to.eventually.be.rejectedWith(/active market not found/i);
    });

    it('should revert when index price is outdated', async () => {
      const indexPrice = await buildIndexPriceWithTimestamp(
        await exchange.getAddress(),
        indexPriceServiceWallet,
        (await getLatestBlockTimestampInSeconds()) * 1000 -
          2 * 24 * 60 * 60 * 1000,
      );

      await expect(
        exchange.publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            indexPrice,
          ),
        ]),
      ).to.eventually.be.rejectedWith(/outdated index price/i);
    });

    it('should revert when index price is too far in future', async () => {
      const indexPrice = await buildIndexPriceWithTimestamp(
        await exchange.getAddress(),
        indexPriceServiceWallet,
        (await getLatestBlockTimestampInSeconds()) * 1000 +
          2 * 24 * 60 * 60 * 1000,
      );

      await expect(
        exchange.publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            indexPrice,
          ),
        ]),
      ).to.eventually.be.rejectedWith(/index price timestamp too high/i);
    });

    it('should revert when index price adapter is not whitelisted', async () => {
      const indexPrice = await buildIndexPrice(
        await exchange.getAddress(),
        indexPriceServiceWallet,
      );
      indexPrice.timestampInMs += 5;

      await expect(
        exchange.publishIndexPrices([
          indexPriceToArgumentStruct(await exchange.getAddress(), indexPrice),
        ]),
      ).to.eventually.be.rejectedWith(/invalid index price adapter/i);
    });

    it('should revert when IPS signature is invalid', async () => {
      const indexPrice = await buildIndexPrice(
        await exchange.getAddress(),
        indexPriceServiceWallet,
      );
      indexPrice.timestampInMs += 5;

      await expect(
        exchange.publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            indexPrice,
          ),
        ]),
      ).to.eventually.be.rejectedWith(/invalid index price signature/i);
    });
  });
});
