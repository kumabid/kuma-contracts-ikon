import BigNumber from 'bignumber.js';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers, network } from 'hardhat';
import {
  increase,
  increaseTo,
} from '@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time';

import {
  decimalToPips,
  fundingPeriodLengthInMs,
  getIndexPriceSignatureTypedData,
  IndexPrice,
  indexPriceToArgumentStruct,
} from '../lib';
import type {
  Exchange_v1,
  FundingMultiplierMock,
  KumaIndexAndOraclePriceAdapter,
  USDC,
} from '../typechain-types';
import {
  addAndActivateMarket,
  baseAssetSymbol,
  buildIndexPrice,
  buildIndexPriceWithTimestamp,
  buildIndexPriceWithValue,
  deployAndAssociateContracts,
  executeTrade,
  fundWallets,
  getLatestBlockTimestampInSeconds,
  pipToDecimal,
  quoteAssetSymbol,
} from './helpers';

describe('Exchange', function () {
  let dispatcherWallet: SignerWithAddress;
  let exchange: Exchange_v1;
  let indexPrice: IndexPrice;
  let indexPriceAdapter: KumaIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    const wallets = await ethers.getSigners();
    dispatcherWallet = wallets[1];
    indexPriceServiceWallet = wallets[4];

    const results = await deployAndAssociateContracts(
      wallets[0],
      dispatcherWallet,
      wallets[2],
      wallets[3],
      indexPriceServiceWallet,
      wallets[5],
      0,
      false,
    );
    exchange = results.exchange;
    indexPriceAdapter = results.indexPriceAdapter;
    usdc = results.usdc;

    await increaseTo(await getMidnightTomorrowInSecondsUTC());
    await addAndActivateMarket(dispatcherWallet, exchange);
    await increase(fundingPeriodLengthInMs / 1000);

    indexPrice = await buildIndexPrice(
      await exchange.getAddress(),
      indexPriceServiceWallet,
    );
  });

  describe('publishFundingMultiplier', async function () {
    it('should work for funding periods after initial backfill when there are no gaps', async function () {
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            indexPrice,
          ),
        ]);

      await exchange
        .connect(dispatcherWallet)
        .publishFundingMultiplier(
          baseAssetSymbol,
          decimalToPips(getFundingRate()),
        );

      await increase(fundingPeriodLengthInMs / 1000);

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
        .publishFundingMultiplier(
          baseAssetSymbol,
          decimalToPips(getFundingRate(1)),
        );

      const multipliers = await loadFundingMultipliers(exchange);
      expect(multipliers).to.be.an('array').with.lengthOf(3);
      expect(multipliers[0]).to.equal('0');
      expect(multipliers[1]).to.equal(
        decimalToPips(
          new BigNumber(indexPrice.price)
            .times(new BigNumber(getFundingRate()))
            .negated()
            .toString(),
        ),
      );
      expect(multipliers[2]).to.equal(
        decimalToPips(
          new BigNumber(indexPrice.price)
            .times(new BigNumber(getFundingRate(1)))
            .negated()
            .toString(),
        ),
      );
    });

    it('should work with missing periods between multipliers', async function () {
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            indexPrice,
          ),
        ]);

      await exchange
        .connect(dispatcherWallet)
        .publishFundingMultiplier(
          baseAssetSymbol,
          decimalToPips(getFundingRate()),
        );

      await increase((fundingPeriodLengthInMs * 4) / 1000);

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
        .publishFundingMultiplier(
          baseAssetSymbol,
          decimalToPips(getFundingRate(1)),
        );

      const multipliers = await loadFundingMultipliers(exchange);
      expect(multipliers).to.be.an('array').with.lengthOf(6);
      expect(multipliers[0]).to.equal('0');
      expect(multipliers[1]).to.equal(
        decimalToPips(
          new BigNumber(indexPrice.price)
            .times(new BigNumber(getFundingRate()))
            .negated()
            .toString(),
        ),
      );
      expect(multipliers[2]).to.equal('0');
      expect(multipliers[3]).to.equal('0');
      expect(multipliers[4]).to.equal('0');
      expect(multipliers[5]).to.equal(
        decimalToPips(
          new BigNumber(indexPrice.price)
            .times(new BigNumber(getFundingRate(1)))
            .negated()
            .toString(),
        ),
      );
    });

    it('should work for outdated but not yet stale index price', async function () {
      indexPrice.timestampInMs -= fundingPeriodLengthInMs / 4;
      indexPrice.signature = await indexPriceServiceWallet.signTypedData(
        ...getIndexPriceSignatureTypedData(
          indexPrice,
          quoteAssetSymbol,
          await exchange.getAddress(),
        ),
      );

      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            indexPrice,
          ),
        ]);

      exchange
        .connect(dispatcherWallet)
        .publishFundingMultiplier(
          baseAssetSymbol,
          decimalToPips(getFundingRate()),
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
    });

    it('should revert for invalid symbol', async function () {
      await expect(
        exchange
          .connect(dispatcherWallet)
          .publishFundingMultiplier('XYZ', decimalToPips(getFundingRate())),
      ).to.eventually.be.rejectedWith(/no active market found/i);
    });

    it('should revert for excessive funding rate', async function () {
      await expect(
        exchange
          .connect(dispatcherWallet)
          .publishFundingMultiplier(baseAssetSymbol, decimalToPips('1.0')),
      ).to.eventually.be.rejectedWith(
        /funding rate exceeds maintenance margin fraction/i,
      );

      await expect(
        exchange
          .connect(dispatcherWallet)
          .publishFundingMultiplier(baseAssetSymbol, decimalToPips('-1.0')),
      ).to.eventually.be.rejectedWith(
        /funding rate exceeds maintenance margin fraction/i,
      );
    });

    it('should revert for stale index price', async function () {
      await expect(
        exchange
          .connect(dispatcherWallet)
          .publishFundingMultiplier(
            baseAssetSymbol,
            decimalToPips(getFundingRate()),
          ),
      ).to.eventually.be.rejectedWith(
        /index price too far before next period/i,
      );
    });

    it('should revert when not called by dispatcher', async function () {
      await expect(
        exchange.publishFundingMultiplier(
          baseAssetSymbol,
          decimalToPips(getFundingRate()),
        ),
      ).to.eventually.be.rejectedWith(/caller must be dispatcher wallet/i);
    });
  });

  describe('applyOutstandingWalletFundingForMarket', async function () {
    it('should work for wallet with outstanding funding payments', async function () {
      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            indexPrice,
          ),
        ]);

      await exchange
        .connect(dispatcherWallet)
        .publishFundingMultiplier(
          baseAssetSymbol,
          decimalToPips(getFundingRate()),
        );

      const trader1Wallet = (await ethers.getSigners())[6];
      const trader2Wallet = (await ethers.getSigners())[7];
      await fundWallets(
        [trader1Wallet, trader2Wallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      const trade = await executeTrade(
        exchange,
        dispatcherWallet,
        await buildIndexPrice(
          await exchange.getAddress(),
          indexPriceServiceWallet,
        ),
        await indexPriceAdapter.getAddress(),
        trader1Wallet,
        trader2Wallet,
      );

      expect(
        (
          await exchange.loadOutstandingWalletFunding(trader1Wallet.address)
        ).toString(),
      ).to.equal('0');
      expect(
        (
          await exchange.loadOutstandingWalletFunding(trader2Wallet.address)
        ).toString(),
      ).to.equal('0');

      // Calls should do nothing
      await exchange.applyOutstandingWalletFundingForMarket(
        trader1Wallet.address,
        baseAssetSymbol,
      );
      await exchange.applyOutstandingWalletFundingForMarket(
        trader2Wallet.address,
        baseAssetSymbol,
      );

      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithTimestamp(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              indexPrice.timestampInMs + fundingPeriodLengthInMs,
            ),
          ),
        ]);

      const originalTrader1QuoteBalance = (
        await exchange.loadBalanceBySymbol(
          trader1Wallet.address,
          quoteAssetSymbol,
        )
      ).toString();
      const originalTrader2QuoteBalance = (
        await exchange.loadBalanceBySymbol(
          trader2Wallet.address,
          quoteAssetSymbol,
        )
      ).toString();

      await exchange
        .connect(dispatcherWallet)
        .publishFundingMultiplier(
          baseAssetSymbol,
          decimalToPips(getFundingRate()),
        );

      const exitWithdrawalQuantity = (
        await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
          trader1Wallet.address,
        )
      ).toString();

      const expectedTrader1FundingPayment = decimalToPips(
        new BigNumber(indexPrice.price)
          .times(new BigNumber(getFundingRate()))
          .times(trade.baseQuantity)
          .toString(),
      );
      expect(
        (
          await exchange.loadOutstandingWalletFunding(trader1Wallet.address)
        ).toString(),
      ).to.equal(expectedTrader1FundingPayment);

      const expectedTrader2FundingPayment = decimalToPips(
        new BigNumber(indexPrice.price)
          .times(new BigNumber(getFundingRate()))
          .negated()
          .times(trade.baseQuantity)
          .toString(),
      );
      expect(
        (
          await exchange.loadOutstandingWalletFunding(trader2Wallet.address)
        ).toString(),
      ).to.equal(expectedTrader2FundingPayment);

      await exchange.applyOutstandingWalletFundingForMarket(
        trader1Wallet.address,
        baseAssetSymbol,
      );
      await exchange.applyOutstandingWalletFundingForMarket(
        trader2Wallet.address,
        baseAssetSymbol,
      );

      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader1Wallet.address,
            quoteAssetSymbol,
          )
        ).toString(),
      ).to.equal(
        new BigNumber(originalTrader1QuoteBalance)
          .plus(new BigNumber(expectedTrader1FundingPayment))
          .toString(),
      );
      expect(
        (
          await exchange.loadBalanceBySymbol(
            trader2Wallet.address,
            quoteAssetSymbol,
          )
        ).toString(),
      ).to.equal(
        new BigNumber(originalTrader2QuoteBalance)
          .plus(new BigNumber(expectedTrader2FundingPayment))
          .toString(),
      );
      expect(
        (
          await exchange.loadQuoteQuantityAvailableForExitWithdrawal(
            trader1Wallet.address,
          )
        ).toString(),
      ).to.equal(exitWithdrawalQuantity);

      expect(
        (
          await exchange.loadOutstandingWalletFunding(trader1Wallet.address)
        ).toString(),
      ).to.equal('0');
      expect(
        (
          await exchange.loadOutstandingWalletFunding(trader2Wallet.address)
        ).toString(),
      ).to.equal('0');

      // Subsequent calls should do nothing
      await exchange.applyOutstandingWalletFundingForMarket(
        trader1Wallet.address,
        baseAssetSymbol,
      );
      await exchange.applyOutstandingWalletFundingForMarket(
        trader2Wallet.address,
        baseAssetSymbol,
      );

      // TODO Verify balance updates
    });

    it('should correctly round individual funding payments', async function () {
      const trader1Wallet = (await ethers.getSigners())[6];
      const trader2Wallet = (await ethers.getSigners())[7];
      await fundWallets(
        [trader1Wallet, trader2Wallet],
        dispatcherWallet,
        exchange,
        usdc,
      );

      indexPrice = await buildIndexPriceWithValue(
        await exchange.getAddress(),
        indexPriceServiceWallet,
        '29897.98017846',
      );

      await executeTrade(
        exchange,
        dispatcherWallet,
        indexPrice,
        await indexPriceAdapter.getAddress(),
        trader1Wallet,
        trader2Wallet,
        baseAssetSymbol,
        '29897.98017846',
        '1.02883000',
      );

      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithTimestamp(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              indexPrice.timestampInMs + fundingPeriodLengthInMs,
              baseAssetSymbol,
              '27678.79000000',
            ),
          ),
        ]);

      await exchange
        .connect(dispatcherWallet)
        .publishFundingMultiplier(baseAssetSymbol, decimalToPips('0.02250000'));

      const fundingPayment1 = new BigNumber('27678.79000000')
        .times(new BigNumber('0.02250000'))
        .times('1.02883000')
        .toFixed(8, BigNumber.ROUND_DOWN);

      expect(
        pipToDecimal(
          await exchange.loadOutstandingWalletFunding(trader1Wallet.address),
        ),
      ).to.equal(fundingPayment1.toString());

      await exchange
        .connect(dispatcherWallet)
        .publishIndexPrices([
          indexPriceToArgumentStruct(
            await indexPriceAdapter.getAddress(),
            await buildIndexPriceWithTimestamp(
              await exchange.getAddress(),
              indexPriceServiceWallet,
              indexPrice.timestampInMs + fundingPeriodLengthInMs * 2,
              baseAssetSymbol,
              '28214.68000000',
            ),
          ),
        ]);

      await exchange
        .connect(dispatcherWallet)
        .publishFundingMultiplier(baseAssetSymbol, decimalToPips('0.02250000'));

      const fundingPayment2 = new BigNumber('28214.68000000')
        .times(new BigNumber('0.02250000'))
        .times('1.02883000')
        .toFixed(8, BigNumber.ROUND_DOWN);

      const totalFundingPayment = new BigNumber(fundingPayment1)
        .plus(new BigNumber(fundingPayment2))
        .toFixed(8, BigNumber.ROUND_DOWN);

      expect(
        pipToDecimal(
          await exchange.loadOutstandingWalletFunding(trader1Wallet.address),
        ),
      ).to.equal(totalFundingPayment.toString());
    });

    it('should revert for invalid symbol', async function () {
      await expect(
        exchange.applyOutstandingWalletFundingForMarket(
          (
            await ethers.getSigners()
          )[6].address,
          'XYZ',
        ),
      ).to.eventually.be.rejectedWith(/market not found/i);
    });

    it('should revert when wallet has no open positions', async function () {
      await expect(
        exchange.applyOutstandingWalletFundingForMarket(
          (
            await ethers.getSigners()
          )[10].address,
          baseAssetSymbol,
        ),
      ).to.eventually.be.rejectedWith(/no open position in market/i);
    });
  });

  describe('loadAggregatePayment', async function () {
    let fundingMultiplierMock: FundingMultiplierMock;

    before(async () => {
      const FundingMultiplierMock = await ethers.getContractFactory(
        'FundingMultiplierMock',
      );
      fundingMultiplierMock = await FundingMultiplierMock.deploy();
    });

    it('should work for single quartet', async function () {
      const earliestTimestampInMs =
        (await getMidnightTomorrowInSecondsUTC()) * 1000;

      await fundingMultiplierMock.publishFundingMultiplier(
        decimalToPips(getFundingRate(0)),
      );
      await expect(
        fundingMultiplierMock.loadAggregatePayment(
          earliestTimestampInMs,
          earliestTimestampInMs,
          earliestTimestampInMs,
          decimalToPips('1.00000000'),
        ),
      ).to.eventually.equal(decimalToPips(getFundingRate(0)));

      await fundingMultiplierMock.publishFundingMultiplier(
        decimalToPips(getFundingRate(1)),
      );
      await expect(
        fundingMultiplierMock.loadAggregatePayment(
          earliestTimestampInMs,
          earliestTimestampInMs + fundingPeriodLengthInMs,
          earliestTimestampInMs + fundingPeriodLengthInMs,
          decimalToPips('1.00000000'),
        ),
      ).to.eventually.equal(
        decimalToPips(
          new BigNumber(getFundingRate(0))
            .plus(new BigNumber(getFundingRate(1)))
            .toString(),
        ),
      );

      await fundingMultiplierMock.publishFundingMultiplier(
        decimalToPips(getFundingRate(2)),
      );
      await expect(
        fundingMultiplierMock.loadAggregatePayment(
          earliestTimestampInMs,
          earliestTimestampInMs + fundingPeriodLengthInMs * 2,
          earliestTimestampInMs + fundingPeriodLengthInMs * 2,
          decimalToPips('1.00000000'),
        ),
      ).to.eventually.equal(
        decimalToPips(
          new BigNumber(getFundingRate(0))
            .plus(new BigNumber(getFundingRate(1)))
            .plus(new BigNumber(getFundingRate(2)))
            .toString(),
        ),
      );

      await fundingMultiplierMock.publishFundingMultiplier(
        decimalToPips(getFundingRate(3)),
      );
      await expect(
        fundingMultiplierMock.loadAggregatePayment(
          earliestTimestampInMs + fundingPeriodLengthInMs * 3,
          earliestTimestampInMs + fundingPeriodLengthInMs * 3,
          earliestTimestampInMs + fundingPeriodLengthInMs * 3,
          decimalToPips('1.00000000'),
        ),
      ).to.eventually.equal(
        decimalToPips(new BigNumber(getFundingRate(3)).toString()),
      );
    });

    it('should work for multiple quartets', async function () {
      const earliestTimestampInMs =
        (await getMidnightTomorrowInSecondsUTC()) * 1000;

      await fundingMultiplierMock.publishFundingMultiplier(
        decimalToPips(getFundingRate(0)),
      );
      await fundingMultiplierMock.publishFundingMultiplier(0);
      await fundingMultiplierMock.publishFundingMultiplier(0);
      await fundingMultiplierMock.publishFundingMultiplier(0);
      await fundingMultiplierMock.publishFundingMultiplier(
        decimalToPips(getFundingRate(1)),
      );
      await fundingMultiplierMock.publishFundingMultiplier(0);
      await fundingMultiplierMock.publishFundingMultiplier(0);
      await fundingMultiplierMock.publishFundingMultiplier(
        decimalToPips(getFundingRate(2)),
      );
      await fundingMultiplierMock.publishFundingMultiplier(0);
      await fundingMultiplierMock.publishFundingMultiplier(0);

      await expect(
        fundingMultiplierMock.loadAggregatePayment(
          earliestTimestampInMs,
          earliestTimestampInMs + fundingPeriodLengthInMs * 9,
          earliestTimestampInMs + fundingPeriodLengthInMs * 9,
          decimalToPips('1.00000000'),
        ),
      ).to.eventually.equal(
        decimalToPips(
          new BigNumber(getFundingRate(0))
            .plus(new BigNumber(getFundingRate(1)))
            .plus(new BigNumber(getFundingRate(2)))
            .toString(),
        ),
      );
    });
  });
});

const fundingRates = [
  '-0.00016100',
  '0.00026400',
  '-0.00028200',
  '-0.00005000',
  '0.00010400',
];
function getFundingRate(index = 0): string {
  return fundingRates[index % fundingRates.length];
}

async function getMidnightTomorrowInSecondsUTC(): Promise<number> {
  const midnightTomorrow = new Date(0);
  midnightTomorrow.setUTCSeconds(await getLatestBlockTimestampInSeconds());
  midnightTomorrow.setUTCHours(24, 0, 0, 0);

  return midnightTomorrow.getTime() / 1000;
}

const NO_FUNDING_MULTIPLIER = (BigInt(-2) ** BigInt(63)).toString();
async function loadFundingMultipliers(exchange: Exchange_v1) {
  const quartets: string[][] = [];
  try {
    let i = 0;
    while (true) {
      quartets.push(
        (
          await exchange.fundingMultipliersByBaseAssetSymbol(baseAssetSymbol, i)
        ).map((m) => m.toString()),
      );

      i += 1;
    }
  } catch (e) {
    if (e instanceof Error && !e.message.match(/^call revert exception/)) {
      console.error(e.message);
    }
  }

  return quartets.flat().filter((q) => q != NO_FUNDING_MULTIPLIER);
}
