import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers } from 'hardhat';

import {
  Custodian,
  Exchange_v1,
  GovernanceMock,
  NativeConverterMock,
  USDC,
  USDCeMigrator,
} from '../typechain-types';
import { decimalToAssetUnits } from '../lib';
import {
  deployContractsExceptCustodian,
  expect,
  quoteAssetDecimals,
} from './helpers';

describe('Exchange', function () {
  describe('migrateQuoteTokenAddress', () => {
    let assetMigrator: USDCeMigrator;
    let custodian: Custodian;
    let exchange: Exchange_v1;
    let governanceMock: GovernanceMock;
    let nativeConverterMock: NativeConverterMock;
    let ownerWallet: SignerWithAddress;
    let usdc: USDC;
    let newUsdc: USDC;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployContractsExceptCustodian(ownerWallet);
      exchange = results.exchange;
      usdc = results.usdc;

      governanceMock = await (
        await ethers.getContractFactory('GovernanceMock')
      ).deploy();
      custodian = await (
        await ethers.getContractFactory('Custodian')
      ).deploy(await exchange.getAddress(), await governanceMock.getAddress());
      await exchange.setCustodian(await custodian.getAddress(), []);
      await governanceMock.setCustodian(await custodian.getAddress());

      newUsdc = await (await ethers.getContractFactory('USDC')).deploy();
      nativeConverterMock = await (
        await ethers.getContractFactory('NativeConverterMock')
      ).deploy(await results.usdc.getAddress(), await newUsdc.getAddress());

      assetMigrator = await (
        await ethers.getContractFactory('USDCeMigrator')
      ).deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );
    });

    it('should work with valid migrator', async () => {
      const balance = decimalToAssetUnits('200.00000000', quoteAssetDecimals);
      await usdc.transfer(await custodian.getAddress(), balance);

      await governanceMock.setAssetMigrator(await assetMigrator.getAddress());

      await expect(
        usdc.balanceOf(await custodian.getAddress()),
      ).to.eventually.equal(balance);

      await exchange.migrateQuoteTokenAddress();

      await expect(
        usdc.balanceOf(await custodian.getAddress()),
      ).to.eventually.equal('0');
      await expect(
        newUsdc.balanceOf(await custodian.getAddress()),
      ).to.eventually.equal(balance);

      await expect(exchange.quoteTokenAddress()).to.eventually.equal(
        await newUsdc.getAddress(),
      );
    });

    it('should work with valid migrator when destination token has been sent to Custodian', async () => {
      const balance = decimalToAssetUnits('200.00000000', quoteAssetDecimals);
      await usdc.transfer(await custodian.getAddress(), balance);

      const extraAmount = BigInt(10000);
      await newUsdc.transfer(await custodian.getAddress(), extraAmount);

      await governanceMock.setAssetMigrator(await assetMigrator.getAddress());

      await expect(
        usdc.balanceOf(await custodian.getAddress()),
      ).to.eventually.equal(balance);

      await exchange.migrateQuoteTokenAddress();

      await expect(
        usdc.balanceOf(await custodian.getAddress()),
      ).to.eventually.equal('0');
      await expect(
        newUsdc.balanceOf(await custodian.getAddress()),
      ).to.eventually.equal(BigInt(balance) + extraAmount);

      await expect(exchange.quoteTokenAddress()).to.eventually.equal(
        await newUsdc.getAddress(),
      );
    });

    it('should revert for invalid source asset', async () => {
      await governanceMock.setAssetMigrator(await assetMigrator.getAddress());

      await exchange.migrateQuoteTokenAddress();

      await expect(
        exchange.migrateQuoteTokenAddress(),
      ).to.eventually.be.rejectedWith(/invalid source asset/i);
    });

    it('should revert when not sent by admin', async () => {
      await expect(
        exchange
          .connect((await ethers.getSigners())[1])
          .migrateQuoteTokenAddress(),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });

    it('should revert when migrator is not set', async () => {
      await expect(
        exchange.migrateQuoteTokenAddress(),
      ).to.eventually.be.rejectedWith(/asset migrator not set/i);
    });

    it('should revert if transfer fails', async () => {
      await governanceMock.setAssetMigrator(await assetMigrator.getAddress());

      await usdc.setIsTransferDisabled(true);

      await expect(
        exchange.migrateQuoteTokenAddress(),
      ).to.eventually.be.rejectedWith(/quote asset transfer failed/i);
    });

    it('should revert if balance is not completely migrated', async () => {
      await governanceMock.setAssetMigrator(await assetMigrator.getAddress());

      await usdc.transfer(await custodian.getAddress(), '100000000000000000');
      await nativeConverterMock.setMintFee('1000');

      await expect(
        exchange.migrateQuoteTokenAddress(),
      ).to.eventually.be.rejectedWith(/balance was not completely migrated/i);
    });
  });
});

describe('USDCeMigrator', function () {
  let custodian: Custodian;
  let exchange: Exchange_v1;
  let governanceMock: GovernanceMock;
  let nativeConverterMock: NativeConverterMock;
  let ownerWallet: SignerWithAddress;
  let newUsdc: USDC;

  beforeEach(async () => {
    [ownerWallet] = await ethers.getSigners();
    const results = await deployContractsExceptCustodian(ownerWallet);
    exchange = results.exchange;

    governanceMock = await (
      await ethers.getContractFactory('GovernanceMock')
    ).deploy();
    custodian = await (
      await ethers.getContractFactory('Custodian')
    ).deploy(await exchange.getAddress(), await governanceMock.getAddress());
    await exchange.setCustodian(await custodian.getAddress(), []);
    await governanceMock.setCustodian(await custodian.getAddress());

    newUsdc = await (await ethers.getContractFactory('USDC')).deploy();
    nativeConverterMock = await (
      await ethers.getContractFactory('NativeConverterMock')
    ).deploy(await results.usdc.getAddress(), await newUsdc.getAddress());
  });

  describe('deploy', () => {
    it('should revert for invalid Custodian', async () => {
      await expect(
        (
          await ethers.getContractFactory('USDCeMigrator')
        ).deploy(ethers.ZeroAddress, await nativeConverterMock.getAddress()),
      ).to.eventually.be.rejectedWith(/invalid custodian address/i);
    });

    it('should revert for invalid native converter', async () => {
      await expect(
        (
          await ethers.getContractFactory('USDCeMigrator')
        ).deploy(await custodian.getAddress(), ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid native converter address/i);
    });
  });

  describe('migrate', () => {
    it('should revert when not called from Custodian', async () => {
      const assetMigrator = await (
        await ethers.getContractFactory('USDCeMigrator')
      ).deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await expect(
        assetMigrator.migrate(await newUsdc.getAddress(), '10000'),
      ).to.eventually.be.rejectedWith(/caller must be custodian/i);
    });
  });
});
