import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import { deployAndAssociateContracts } from './helpers';
import type { Exchange_v1 } from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('Exchange', function () {
  let exchange: Exchange_v1;
  let ownerWallet: SignerWithAddress;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    [ownerWallet] = await ethers.getSigners();
    const results = await deployAndAssociateContracts(ownerWallet);
    exchange = results.exchange;
  });

  describe('setChainPropagationPeriod', async function () {
    it('should work for valid argument', async () => {
      await exchange.connect(ownerWallet).setChainPropagationPeriod(22);

      expect((await exchange.chainPropagationPeriodInS()).toString()).to.equal(
        '22',
      );
    });

    it('should revert for argument over max', async () => {
      await expect(
        exchange.setChainPropagationPeriod('10000000000'),
      ).to.eventually.be.rejectedWith(/must be less than max/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setChainPropagationPeriod(0),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('setDelegateKeyExpirationPeriod', async function () {
    it('should work for valid argument', async () => {
      await exchange.connect(ownerWallet).setDelegateKeyExpirationPeriod(22);

      expect(
        (await exchange.delegateKeyExpirationPeriodInMs()).toString(),
      ).to.equal('22');
    });

    it('should revert for argument over max', async () => {
      await expect(
        exchange
          .connect(ownerWallet)
          .setDelegateKeyExpirationPeriod('100000000000000'),
      ).to.eventually.be.rejectedWith(/must be less than max/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setDelegateKeyExpirationPeriod(0),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('setPositionBelowMinimumLiquidationPriceToleranceMultiplier', async function () {
    it('should work for valid argument', async () => {
      await exchange
        .connect(ownerWallet)
        .setPositionBelowMinimumLiquidationPriceToleranceMultiplier(200000);

      expect(
        (
          await exchange.positionBelowMinimumLiquidationPriceToleranceMultiplier()
        ).toString(),
      ).to.equal('200000');
    });

    it('should revert for argument over max', async () => {
      await expect(
        exchange
          .connect(ownerWallet)
          .setPositionBelowMinimumLiquidationPriceToleranceMultiplier(
            '100000000000000',
          ),
      ).to.eventually.be.rejectedWith(/must be less than max/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .setPositionBelowMinimumLiquidationPriceToleranceMultiplier(0),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });
});
