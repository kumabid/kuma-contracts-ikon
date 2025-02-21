import { expect } from 'chai';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers, network } from 'hardhat';

import { decimalToAssetUnits } from '../lib';
import type { Exchange_v1, USDC } from '../typechain-types';
import {
  buildIndexPrice,
  deployAndAssociateContracts,
  executeTrade,
  fundWallets,
  quoteAssetDecimals,
} from './helpers';

describe('Exchange', function () {
  let exchange: Exchange_v1;
  let ownerWallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    [ownerWallet] = await ethers.getSigners();
    const results = await deployAndAssociateContracts(ownerWallet);
    exchange = results.exchange;
    usdc = results.usdc;
  });

  describe('setExitFundWallet', async function () {
    it('should work for valid wallet', async () => {
      const [, exitFundWallet] = await ethers.getSigners();

      await exchange.setExitFundWallet(exitFundWallet.address);

      expect(await exchange.exitFundWallet()).to.equal(exitFundWallet.address);
    });

    it('should revert for invalid wallet', async () => {
      await expect(
        exchange.setExitFundWallet(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid EF wallet/i);
    });

    it('should revert for wallet already set', async () => {
      await expect(
        exchange.setExitFundWallet(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/must be different/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setExitFundWallet(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });

    it('should revert when EF has an open position', async () => {
      const { exchange: exitedExchange } = await bootstrapExitedWallet();

      await expect(
        exitedExchange.setExitFundWallet(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/current EF cannot have open balance/i);
    });

    it('should revert when EF has open quote balance', async () => {
      const {
        chainlinkAggregator,
        exchange: exitedExchange,
        trader2Wallet,
      } = await bootstrapExitedWallet();

      await chainlinkAggregator.setPrice(
        decimalToAssetUnits('1500.00000000', quoteAssetDecimals),
      );
      await exitedExchange.connect(trader2Wallet).exitWallet();
      await exitedExchange.withdrawExit(trader2Wallet.address);

      await expect(
        exitedExchange.setExitFundWallet(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/current EF cannot have open balance/i);
    });

    it('should revert when new EF has an open position', async () => {
      const [, traderWallet] = await ethers.getSigners();
      await fundWallets([traderWallet], ownerWallet, exchange, usdc);

      await expect(
        exchange.setExitFundWallet(traderWallet.address),
      ).to.eventually.be.rejectedWith(/new EF cannot have open balance/i);
    });
  });

  describe('setFeeWallet', async function () {
    it('should work for valid wallet', async () => {
      const [, feeWallet] = await ethers.getSigners();

      await exchange.setFeeWallet(feeWallet.address);

      expect(await exchange.feeWallet()).to.equal(feeWallet.address);
    });

    it('should revert for invalid wallet', async () => {
      await expect(
        exchange.setFeeWallet(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid fee wallet/i);
    });

    it('should revert for wallet already set', async () => {
      await expect(
        exchange.setFeeWallet(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/must be different/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setFeeWallet(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('setDispatcher', async function () {
    it('should work for valid wallet', async () => {
      const [ownerWallet, dispatcherWallet] = await ethers.getSigners();

      await exchange
        .connect(ownerWallet)
        .setDispatcher(dispatcherWallet.address);

      expect(await exchange.dispatcherWallet()).to.equal(
        dispatcherWallet.address,
      );

      const events = await exchange.queryFilter(
        exchange.filters.DispatcherChanged(),
      );
      expect(events).to.have.lengthOf(2);
      expect(events[1].args?.previousValue).to.equal(ownerWallet.address);
      expect(events[1].args?.newValue).to.equal(dispatcherWallet.address);
    });

    it('should revert for invalid wallet', async () => {
      await expect(
        exchange.setDispatcher(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid wallet/i);
    });

    it('should revert for wallet already set', async () => {
      await expect(
        exchange.setDispatcher(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/must be different/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setDispatcher(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });
});

async function bootstrapExitedWallet() {
  const [
    ownerWallet,
    dispatcherWallet,
    exitFundWallet,
    feeWallet,
    insuranceFundWallet,
    indexPriceServiceWallet,
    trader1Wallet,
    trader2Wallet,
  ] = await ethers.getSigners();
  const { chainlinkAggregator, exchange, indexPriceAdapter, usdc } =
    await deployAndAssociateContracts(
      ownerWallet,
      dispatcherWallet,
      exitFundWallet,
      feeWallet,
      indexPriceServiceWallet,
      insuranceFundWallet,
    );

  await usdc.connect(dispatcherWallet).faucet(dispatcherWallet.address);

  await fundWallets(
    [trader1Wallet, trader2Wallet, insuranceFundWallet],
    dispatcherWallet,
    exchange,
    usdc,
  );

  const indexPrice = await buildIndexPrice(
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

  // Deposit additional quote to allow for EF exit withdrawal
  const depositQuantity = ethers.parseUnits('100000.0', quoteAssetDecimals);
  await usdc
    .connect(ownerWallet)
    .approve(await exchange.getAddress(), depositQuantity);
  await (
    await exchange
      .connect(ownerWallet)
      .deposit(depositQuantity, ethers.ZeroAddress)
  ).wait();

  await exchange.connect(trader1Wallet).exitWallet();
  await exchange.withdrawExit(trader1Wallet.address);

  return { chainlinkAggregator, exchange, trader1Wallet, trader2Wallet };
}
