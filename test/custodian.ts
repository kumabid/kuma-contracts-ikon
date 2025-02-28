import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers, network } from 'hardhat';

import {
  Custodian,
  Custodian__factory,
  Exchange_v1,
  Exchange_v1__factory,
  ExchangeWithdrawMock,
  ExchangeWithdrawMock__factory,
  Governance,
  GovernanceMock,
  GovernanceMock__factory,
  Governance__factory,
  NativeConverterMock,
  USDC,
  USDC__factory,
  USDCeMigrator__factory,
} from '../typechain-types';
import {
  deployContractsExceptCustodian,
  expect,
  quoteAssetDecimals,
} from './helpers';

describe('Custodian', function () {
  let CustodianFactory: Custodian__factory;
  let ExchangeWithdrawMockFactory: ExchangeWithdrawMock__factory;
  let GovernanceFactory: Governance__factory;
  let GovernanceMockFactory: GovernanceMock__factory;
  let USDCFactory: USDC__factory;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    [
      CustodianFactory,
      ExchangeWithdrawMockFactory,
      GovernanceFactory,
      GovernanceMockFactory,
      USDCFactory,
    ] = await Promise.all([
      ethers.getContractFactory('Custodian'),
      ethers.getContractFactory('ExchangeWithdrawMock'),
      ethers.getContractFactory('Governance'),
      ethers.getContractFactory('GovernanceMock'),
      ethers.getContractFactory('USDC'),
    ]);
  });

  describe('deploy', async function () {
    let exchange: Exchange_v1;
    let governance: Governance;

    beforeEach(async () => {
      const [owner] = await ethers.getSigners();
      const results = await deployContractsExceptCustodian(owner);
      exchange = results.exchange;
      governance = results.governance;
    });

    it('should work', async () => {
      await CustodianFactory.deploy(
        await exchange.getAddress(),
        await governance.getAddress(),
      );
    });

    it('should revert for invalid exchange address', async () => {
      await expect(
        CustodianFactory.deploy(
          ethers.ZeroAddress,
          await governance.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/invalid exchange contract address/i);
    });

    it('should revert for invalid governance address', async () => {
      await expect(
        CustodianFactory.deploy(
          await exchange.getAddress(),
          ethers.ZeroAddress,
        ),
      ).to.eventually.be.rejectedWith(/invalid governance contract address/i);
    });
  });

  describe('migrateAsset', () => {
    let custodian: Custodian;
    let governanceMock: GovernanceMock;
    let ownerWallet: SignerWithAddress;
    let nativeConverterMock: NativeConverterMock;
    let newUsdc: USDC;
    let USDCeMigratorFactory: USDCeMigrator__factory;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployContractsExceptCustodian(ownerWallet);
      governanceMock = await GovernanceMockFactory.deploy();
      custodian = await CustodianFactory.deploy(
        await results.exchange.getAddress(),
        await governanceMock.getAddress(),
      );
      await governanceMock.setCustodian(await custodian.getAddress());
      newUsdc = await (await ethers.getContractFactory('USDC')).deploy();
      nativeConverterMock = await (
        await ethers.getContractFactory('NativeConverterMock')
      ).deploy(await results.usdc.getAddress(), await newUsdc.getAddress());
      USDCeMigratorFactory = await ethers.getContractFactory('USDCeMigrator');
    });

    it('should revert for invalid source asset', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );
      await governanceMock.setAssetMigrator(await assetMigrator.getAddress());
      await governanceMock.setExchange(await governanceMock.getAddress());

      await expect(
        governanceMock.migrateAsset(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid source asset/i);
    });

    it('should revert when not called by Exchange', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );
      await governanceMock.setAssetMigrator(await assetMigrator.getAddress());
      await governanceMock.setExchange(await governanceMock.getAddress());

      await expect(
        custodian.migrateAsset(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/caller must be exchange/i);
    });
  });

  describe('setAssetMigrator', () => {
    let custodian: Custodian;
    let governanceMock: GovernanceMock;
    let ownerWallet: SignerWithAddress;
    let nativeConverterMock: NativeConverterMock;
    let newUsdc: USDC;
    let USDCeMigratorFactory: USDCeMigrator__factory;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployContractsExceptCustodian(ownerWallet);
      governanceMock = await GovernanceMockFactory.deploy();
      custodian = await CustodianFactory.deploy(
        await results.exchange.getAddress(),
        await governanceMock.getAddress(),
      );
      await governanceMock.setCustodian(await custodian.getAddress());
      newUsdc = await (await ethers.getContractFactory('USDC')).deploy();
      nativeConverterMock = await (
        await ethers.getContractFactory('NativeConverterMock')
      ).deploy(await results.usdc.getAddress(), await newUsdc.getAddress());
      USDCeMigratorFactory = await ethers.getContractFactory('USDCeMigrator');
    });

    it('should work when sent from Governance', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await governanceMock.setAssetMigrator(await assetMigrator.getAddress());

      expect(custodian.queryFilter(custodian.filters.AssetMigratorChanged()))
        .to.eventually.be.an('array')
        .with.lengthOf(1);
    });

    it('should revert when not sent from Governance', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await expect(
        custodian.setAssetMigrator(await assetMigrator.getAddress()),
      ).to.eventually.be.rejectedWith(/caller must be governance contract/i);
    });

    it('should revert for invalid address', async () => {
      await expect(
        governanceMock.setAssetMigrator(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/invalid contract address/i);
    });
  });

  describe('setExchange', () => {
    let custodian: Custodian;
    let ExchangeFactory: Exchange_v1__factory;
    let governanceMock: GovernanceMock;
    let ownerWallet: SignerWithAddress;
    let usdc: USDC;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployContractsExceptCustodian(ownerWallet);
      ExchangeFactory = results.ExchangeFactory;
      usdc = results.usdc;
      governanceMock = await GovernanceMockFactory.deploy();
      custodian = await CustodianFactory.deploy(
        await results.exchange.getAddress(),
        await governanceMock.getAddress(),
      );
      governanceMock.setCustodian(await custodian.getAddress());
    });

    it('should work when sent from Governance', async () => {
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      await governanceMock.setExchange(await newExchange.getAddress());

      expect(custodian.queryFilter(custodian.filters.ExchangeChanged()))
        .to.eventually.be.an('array')
        .with.lengthOf(2);
    });

    it('should revert for invalid address', async () => {
      await expect(
        governanceMock.setExchange(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid contract address/i);
    });

    it('should revert for non-contract address', async () => {
      await expect(
        governanceMock.setExchange(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/invalid contract address/i);
    });

    it('should revert when not sent from Governance', async () => {
      await expect(
        custodian
          .connect((await ethers.getSigners())[1])
          .setExchange(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/caller must be governance/i);
    });
  });

  describe('setGovernance', () => {
    let custodian: Custodian;
    let governanceMock: GovernanceMock;
    let ownerWallet: SignerWithAddress;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployContractsExceptCustodian(ownerWallet);
      governanceMock = await GovernanceMockFactory.deploy();
      custodian = await CustodianFactory.deploy(
        await results.exchange.getAddress(),
        await governanceMock.getAddress(),
      );
      await governanceMock.setCustodian(await custodian.getAddress());
    });

    it('should work when sent from Governance', async () => {
      const newGovernance = await GovernanceFactory.deploy(0);

      await governanceMock.setGovernance(await newGovernance.getAddress());

      expect(custodian.queryFilter(custodian.filters.GovernanceChanged()))
        .to.eventually.be.an('array')
        .with.lengthOf(2);
    });

    it('should revert for invalid address', async () => {
      await expect(
        governanceMock.setGovernance(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid contract address/i);
    });

    it('should revert for non-contract address', async () => {
      await expect(
        governanceMock.setGovernance(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/invalid contract address/i);
    });

    it('should revert when not sent from Governance', async () => {
      await expect(
        custodian
          .connect((await ethers.getSigners())[1])
          .setGovernance(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/caller must be governance/i);
    });
  });

  describe('withdraw', () => {
    let custodian: Custodian;
    let exchangeWithdrawMock: ExchangeWithdrawMock;
    let governance: Governance;
    let usdc: USDC;

    beforeEach(async () => {
      exchangeWithdrawMock = await ExchangeWithdrawMockFactory.deploy();
      governance = await GovernanceFactory.deploy(0);
      custodian = await CustodianFactory.deploy(
        await exchangeWithdrawMock.getAddress(),
        await governance.getAddress(),
      );
      await exchangeWithdrawMock.setCustodian(await custodian.getAddress());
      usdc = await (await USDCFactory.deploy()).waitForDeployment();
    });

    it('should work when sent from exchange', async () => {
      const depositQuantity = ethers.parseUnits('5.0', quoteAssetDecimals);
      const destinationWallet = (await ethers.getSigners())[1];

      await usdc.transfer(await custodian.getAddress(), depositQuantity);
      await exchangeWithdrawMock.withdraw(
        destinationWallet.address,
        await usdc.getAddress(),
        depositQuantity,
      );
    });

    it('should revert when quote asset transfer fails', async () => {
      const depositQuantity = ethers.parseUnits('5.0', quoteAssetDecimals);
      const destinationWallet = (await ethers.getSigners())[1];

      await usdc.transfer(await custodian.getAddress(), depositQuantity);
      await usdc.setIsTransferDisabled(true);

      await expect(
        exchangeWithdrawMock.withdraw(
          destinationWallet.address,
          await usdc.getAddress(),
          depositQuantity,
        ),
      ).to.eventually.be.rejectedWith(/quote asset transfer failed/i);
    });

    it('should revert when not sent from exchange', async () => {
      await expect(
        custodian.withdraw(
          (
            await ethers.getSigners()
          )[1].address,
          await usdc.getAddress(),
          '100000000',
        ),
      ).to.eventually.be.rejectedWith(/caller must be exchange/i);
    });
  });
});
