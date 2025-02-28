import { time } from '@nomicfoundation/hardhat-network-helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers, network } from 'hardhat';

import {
  baseAssetSymbol,
  buildIndexPrice,
  deployAndAssociateContracts,
  executeTrade,
  expect,
  fundWallets,
} from './helpers';
import { fieldUpgradeDelayInS, IndexPrice } from '../lib';
import type {
  ChainlinkAggregatorMock,
  Exchange_v1,
  KumaIndexAndOraclePriceAdapter,
  Governance,
} from '../typechain-types';

describe('Exchange', function () {
  let chainlinkAggregator: ChainlinkAggregatorMock;
  let exchange: Exchange_v1;
  let exitFundWallet: SignerWithAddress;
  let governance: Governance;
  let indexPrice: IndexPrice;
  let indexPriceAdapter: KumaIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let insuranceFundWallet: SignerWithAddress;
  let ownerWallet: SignerWithAddress;
  let dispatcherWallet: SignerWithAddress;
  let trader1Wallet: SignerWithAddress;
  let trader2Wallet: SignerWithAddress;

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
    governance = results.governance;
    indexPriceAdapter = results.indexPriceAdapter;
    chainlinkAggregator = results.chainlinkAggregator;

    await results.usdc.faucet(dispatcherWallet.address);

    await fundWallets(
      [trader1Wallet, trader2Wallet],
      dispatcherWallet,
      exchange,
      results.usdc,
    );

    indexPrice = await buildIndexPrice(
      await exchange.getAddress(),
      indexPriceServiceWallet,
    );

    await executeTrade(
      exchange,
      dispatcherWallet,
      indexPrice,
      await indexPriceAdapter.getAddress(),
      trader1Wallet,
      trader2Wallet,
    );
  });

  describe('index price margin', () => {
    describe('loadTotalAccountValueFromIndexPrices', () => {
      it('should work for wallet with open position', async () => {
        const totalAccountValue =
          await exchange.loadTotalAccountValueFromIndexPrices(
            trader1Wallet.address,
          );
        // TODO value assertions
      });

      describe('loadTotalInitialMarginRequirementFromIndexPrices', () => {
        it('should work for wallet with open position', async () => {
          const totalInitialMarginRequirement =
            await exchange.loadTotalInitialMarginRequirementFromIndexPrices(
              trader1Wallet.address,
            );
          // TODO value assertions
        });

        it('should work for wallet with open position exceeding baseline size', async () => {
          const overrides = {
            initialMarginFraction: '5000000',
            maintenanceMarginFraction: '3000000',
            incrementalInitialMarginFraction: '1000000',
            baselinePositionSize: '500000000',
            incrementalPositionSize: '2800000000',
            maximumPositionSize: '282000000000',
            minimumPositionSize: '100000000',
          };
          await governance
            .connect(ownerWallet)
            .initiateMarketOverridesUpgrade(
              baseAssetSymbol,
              overrides,
              trader1Wallet.address,
            );
          await time.increase(fieldUpgradeDelayInS);
          await governance
            .connect(dispatcherWallet)
            .finalizeMarketOverridesUpgrade(
              baseAssetSymbol,
              overrides,
              trader1Wallet.address,
            );

          const totalInitialMarginRequirement =
            await exchange.loadTotalInitialMarginRequirementFromIndexPrices(
              trader1Wallet.address,
            );
          // TODO value assertions
        });
      });

      describe('loadTotalMaintenanceMarginRequirementFromIndexPrices', () => {
        it('should work for wallet with open position', async () => {
          const totalMaintenanceMarginRequirement =
            await exchange.loadTotalMaintenanceMarginRequirementFromIndexPrices(
              trader1Wallet.address,
            );
          // TODO value assertions
        });
      });
    });
  });

  describe('oracle price margin', () => {
    describe('ChainlinkAggregatorMock', () => {
      it('should implement AggregatorV3Interface', async () => {
        await expect(chainlinkAggregator.decimals()).to.eventually.be.a(
          'BigInt',
        );
        await expect(chainlinkAggregator.description()).to.eventually.be.a(
          'string',
        );
        await expect(chainlinkAggregator.getRoundData(0)).to.eventually.be.an(
          'array',
        );
        await expect(chainlinkAggregator.version()).to.eventually.be.a(
          'BigInt',
        );
      });
    });

    describe('loadTotalAccountValueFromOraclePrices', () => {
      it('should work for wallet with open position', async () => {
        const totalAccountValue =
          await exchange.loadTotalAccountValueFromOraclePrices(
            trader1Wallet.address,
          );
        // TODO value assertions
      });
    });

    describe('loadTotalInitialMarginRequirementFromOraclePrices', () => {
      it('should work for wallet with open position', async () => {
        const totalInitialMarginRequirement =
          await exchange.loadTotalInitialMarginRequirementFromOraclePrices(
            trader1Wallet.address,
          );
        // TODO value assertions
      });
    });

    describe('loadTotalMaintenanceMarginRequirementFromOraclePrices', () => {
      it('should work for wallet with open position', async () => {
        const totalMaintenanceMarginRequirement =
          await exchange.loadTotalMaintenanceMarginRequirementFromOraclePrices(
            trader1Wallet.address,
          );
        // TODO value assertions
      });
    });
  });

  describe('loadTotalAccountValueFromOraclePrices', () => {
    it('should revert for negative feed price', async () => {
      await chainlinkAggregator.setPrice(-100);
      await expect(
        exchange.loadTotalAccountValueFromOraclePrices(trader1Wallet.address),
      ).to.eventually.be.rejectedWith(/unexpected non-positive feed price/i);
    });
  });
});
