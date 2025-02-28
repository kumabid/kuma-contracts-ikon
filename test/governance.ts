import { ethers, network } from 'hardhat';

import { deployAndAssociateContracts, expect } from './helpers';
import {
  Custodian,
  Exchange_v1,
  Exchange_v1__factory,
  Governance,
  Governance__factory,
  USDC,
  NativeConverterMock,
  USDCeMigrator__factory,
} from '../typechain-types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('Governance', function () {
  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  let GovernanceFactory: Governance__factory;

  beforeEach(async () => {
    GovernanceFactory = await ethers.getContractFactory('Governance');
  });

  describe('deploy', async function () {
    it('should work', async () => {
      await GovernanceFactory.deploy(0);
    });
  });

  describe('setAdmin', () => {
    let governance: Governance;

    beforeEach(async () => {
      governance = await GovernanceFactory.deploy(0);
    });

    it('should work for valid wallet', async () => {
      await governance.setAdmin((await ethers.getSigners())[1].address);
    });

    it('should revert for zero address', async () => {
      await expect(
        governance.setAdmin(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid wallet address/i);
    });

    it('should revert for same wallet already set', async () => {
      await governance.setAdmin((await ethers.getSigners())[1].address);

      await expect(
        governance.setAdmin((await ethers.getSigners())[1].address),
      ).to.eventually.be.rejectedWith(/must be different from current admin/i);
    });

    it('should revert when not called by owner', async () => {
      const nonOwnerWallet = (await ethers.getSigners())[1];

      const governance = await GovernanceFactory.deploy(0);
      await expect(
        governance.connect(nonOwnerWallet).setAdmin(nonOwnerWallet.address),
      ).to.eventually.be.rejectedWith(/caller must be owner/i);
    });
  });

  describe('setOwner', () => {
    let governance: Governance;

    beforeEach(async () => {
      governance = await GovernanceFactory.deploy(0);
    });

    it('should work for valid wallet', async () => {
      await governance.setOwner((await ethers.getSigners())[1].address);
    });

    it('should revert for zero address', async () => {
      await expect(
        governance.setOwner(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid wallet address/i);
    });

    it('should revert for same wallet already set', async () => {
      await expect(
        governance.setOwner(await governance.ownerWallet()),
      ).to.eventually.be.rejectedWith(/must be different from current owner/i);
    });

    it('should revert when not called by owner', async () => {
      const nonOwnerWallet = (await ethers.getSigners())[1];

      const governance = await GovernanceFactory.deploy(0);
      await expect(
        governance.connect(nonOwnerWallet).setOwner(nonOwnerWallet.address),
      ).to.eventually.be.rejectedWith(/caller must be owner/i);
    });
  });

  describe('removeAdmin', async function () {
    it('should work', async () => {
      const governance = await GovernanceFactory.deploy(0);
      await governance.removeAdmin();
    });

    it('should revert when not called by owner', async () => {
      const governance = await GovernanceFactory.deploy(0);
      await expect(
        governance.connect((await ethers.getSigners())[1]).removeAdmin(),
      ).to.eventually.be.rejectedWith(/caller must be owner/i);
    });
  });

  describe('removeOwner', async function () {
    it('should work', async () => {
      const governance = await GovernanceFactory.deploy(0);
      await governance.removeOwner();
    });

    it('should revert when not called by owner', async () => {
      const governance = await GovernanceFactory.deploy(0);
      await expect(
        governance.connect((await ethers.getSigners())[1]).removeOwner(),
      ).to.eventually.be.rejectedWith(/caller must be owner/i);
    });
  });

  describe('setCustodian', () => {
    let governance: Governance;

    beforeEach(async () => {
      governance = await GovernanceFactory.deploy(0);
    });

    it('should revert for zero address', async () => {
      await expect(
        governance.setCustodian(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid address/i);
    });

    it('should revert if set more than once', async () => {
      const [ownerWallet] = await ethers.getSigners();
      const { custodian, governance } = await deployAndAssociateContracts(
        ownerWallet,
      );

      await expect(
        governance.setCustodian(await custodian.getAddress()),
      ).to.eventually.be.rejectedWith(/custodian can only be set once/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .setCustodian(await governance.getAddress()),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('initiateAssetMigratorUpgrade', () => {
    let custodian: Custodian;
    let governance: Governance;
    let ownerWallet: SignerWithAddress;
    let nativeConverterMock: NativeConverterMock;
    let newUsdc: USDC;
    let USDCeMigratorFactory: USDCeMigrator__factory;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      custodian = results.custodian;
      governance = results.governance;
      newUsdc = await (await ethers.getContractFactory('USDC')).deploy();
      nativeConverterMock = await (
        await ethers.getContractFactory('NativeConverterMock')
      ).deploy(await results.usdc.getAddress(), await newUsdc.getAddress());
      USDCeMigratorFactory = await ethers.getContractFactory('USDCeMigrator');
    });

    it('should work for valid contract address', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await governance.initiateAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );
    });

    it('should revert for zero contract address', async () => {
      await expect(
        governance.initiateAssetMigratorUpgrade(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid address/i);
    });

    it('should revert for same Asset Migrator address', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await governance.initiateAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );
      await governance.finalizeAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );

      await expect(
        governance.initiateAssetMigratorUpgrade(
          await assetMigrator.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(
        /must be different from current asset migrator/i,
      );
    });

    it('should revert when upgrade already in progress', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await governance.initiateAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );
      await expect(
        governance.initiateAssetMigratorUpgrade(
          await assetMigrator.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(
        /asset migrator upgrade already in progress/i,
      );
    });

    it('should revert when not called by admin', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .initiateAssetMigratorUpgrade(await assetMigrator.getAddress()),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('cancelAssetMigratorUpgrade', () => {
    let custodian: Custodian;
    let governance: Governance;
    let ownerWallet: SignerWithAddress;
    let nativeConverterMock: NativeConverterMock;
    let newUsdc: USDC;
    let USDCeMigratorFactory: USDCeMigrator__factory;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      custodian = results.custodian;
      governance = results.governance;
      newUsdc = await (await ethers.getContractFactory('USDC')).deploy();
      nativeConverterMock = await (
        await ethers.getContractFactory('NativeConverterMock')
      ).deploy(await results.usdc.getAddress(), await newUsdc.getAddress());
      USDCeMigratorFactory = await ethers.getContractFactory('USDCeMigrator');
    });

    it('should work when upgrade was initiated', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await governance.initiateAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );
      await governance.cancelAssetMigratorUpgrade();
    });

    it('should revert when no upgrade was initiated', async () => {
      await expect(
        governance.cancelAssetMigratorUpgrade(),
      ).to.eventually.be.rejectedWith(/no asset migrator upgrade in progress/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .cancelAssetMigratorUpgrade(),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('finalizeExchangeUpgrade', () => {
    let custodian: Custodian;
    let governance: Governance;
    let ownerWallet: SignerWithAddress;
    let newUsdc: USDC;
    let nativeConverterMock: NativeConverterMock;
    let USDCeMigratorFactory: USDCeMigrator__factory;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      custodian = results.custodian;
      governance = results.governance;
      newUsdc = await (await ethers.getContractFactory('USDC')).deploy();
      nativeConverterMock = await (
        await ethers.getContractFactory('NativeConverterMock')
      ).deploy(await results.usdc.getAddress(), await newUsdc.getAddress());
      USDCeMigratorFactory = await ethers.getContractFactory('USDCeMigrator');
    });

    it('should work when upgrade was initiated and addresses match', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await governance.initiateAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );
      await governance.finalizeAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );

      await expect(custodian.assetMigrator()).to.eventually.equal(
        await assetMigrator.getAddress(),
      );
    });

    it('should revert when no upgrade was initiated', async () => {
      await expect(
        governance.finalizeAssetMigratorUpgrade(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/no asset migrator upgrade in progress/i);
    });

    it('should revert when upgrade was initiated and addresses mismatch', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await governance.initiateAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );
      await expect(
        governance.finalizeAssetMigratorUpgrade(await governance.getAddress()),
      ).to.eventually.be.rejectedWith(/address mismatch/i);
    });

    it('should revert when block threshold not yet reached', async () => {
      const results = await deployAndAssociateContracts(
        ownerWallet,
        ownerWallet,
        ownerWallet,
        ownerWallet,
        ownerWallet,
        ownerWallet,
        100,
      );
      governance = results.governance;
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await governance.initiateAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );
      await expect(
        governance.finalizeAssetMigratorUpgrade(
          await assetMigrator.getAddress(),
        ),
      ).to.eventually.be.rejectedWith(/block threshold not yet reached/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .finalizeAssetMigratorUpgrade(await governance.getAddress()),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('clearAssetMigrator', () => {
    let custodian: Custodian;
    let governance: Governance;
    let ownerWallet: SignerWithAddress;
    let nativeConverterMock: NativeConverterMock;
    let newUsdc: USDC;
    let USDCeMigratorFactory: USDCeMigrator__factory;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      custodian = results.custodian;
      governance = results.governance;
      newUsdc = await (await ethers.getContractFactory('USDC')).deploy();
      nativeConverterMock = await (
        await ethers.getContractFactory('NativeConverterMock')
      ).deploy(await results.usdc.getAddress(), await newUsdc.getAddress());
      USDCeMigratorFactory = await ethers.getContractFactory('USDCeMigrator');
    });

    it('should work migrator is set', async () => {
      const assetMigrator = await USDCeMigratorFactory.deploy(
        await custodian.getAddress(),
        await nativeConverterMock.getAddress(),
      );

      await governance.initiateAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );
      await governance.finalizeAssetMigratorUpgrade(
        await assetMigrator.getAddress(),
      );

      await governance.clearAssetMigrator();

      await expect(custodian.assetMigrator()).to.eventually.equal(
        ethers.ZeroAddress,
      );
    });

    it('should revert when not sent by admin', async () => {
      await expect(
        governance.connect((await ethers.getSigners())[1]).clearAssetMigrator(),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });

    it('should revert when migrator is not set', async () => {
      await expect(
        governance.clearAssetMigrator(),
      ).to.eventually.be.rejectedWith(/asset migrator not set/i);
    });
  });

  describe('initiateExchangeUpgrade', () => {
    let exchange: Exchange_v1;
    let ExchangeFactory: Exchange_v1__factory;
    let governance: Governance;
    let ownerWallet: SignerWithAddress;
    let usdc: USDC;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      exchange = results.exchange;
      ExchangeFactory = results.ExchangeFactory;
      governance = results.governance;
      usdc = results.usdc;
    });

    it('should work for valid contract address', async () => {
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      await governance.initiateExchangeUpgrade(await newExchange.getAddress());
    });

    it('should revert for zero contract address', async () => {
      await expect(
        governance.initiateExchangeUpgrade(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid address/i);
    });

    it('should revert for same Exchange address', async () => {
      await expect(
        governance.initiateExchangeUpgrade(await exchange.getAddress()),
      ).to.eventually.be.rejectedWith(
        /must be different from current exchange/i,
      );
    });

    it('should revert when upgrade already in progress', async () => {
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      await governance.initiateExchangeUpgrade(await newExchange.getAddress());
      await expect(
        governance.initiateExchangeUpgrade(await newExchange.getAddress()),
      ).to.eventually.be.rejectedWith(/exchange upgrade already in progress/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .initiateExchangeUpgrade(await governance.getAddress()),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('cancelExchangeUpgrade', () => {
    let ExchangeFactory: Exchange_v1__factory;
    let governance: Governance;
    let ownerWallet: SignerWithAddress;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      ExchangeFactory = results.ExchangeFactory;
      governance = results.governance;
    });

    it('should work when upgrade was initiated', async () => {
      const usdc = await (await ethers.getContractFactory('USDC')).deploy();
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      await governance.initiateExchangeUpgrade(await newExchange.getAddress());
      await governance.cancelExchangeUpgrade();
    });

    it('should revert when no upgrade was initiated', async () => {
      await expect(
        governance.cancelExchangeUpgrade(),
      ).to.eventually.be.rejectedWith(/no exchange upgrade in progress/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .cancelExchangeUpgrade(),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('finalizeExchangeUpgrade', () => {
    let custodian: Custodian;
    let ExchangeFactory: Exchange_v1__factory;
    let governance: Governance;
    let ownerWallet: SignerWithAddress;
    let usdc: USDC;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      ExchangeFactory = results.ExchangeFactory;
      custodian = results.custodian;
      governance = results.governance;
      usdc = results.usdc;
    });

    it('should work when upgrade was initiated and addresses match', async () => {
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      await governance.initiateExchangeUpgrade(await newExchange.getAddress());
      await governance.finalizeExchangeUpgrade(await newExchange.getAddress());

      await expect(custodian.exchange()).to.eventually.equal(
        await newExchange.getAddress(),
      );
    });

    it('should revert when no upgrade was initiated', async () => {
      await expect(
        governance.finalizeExchangeUpgrade(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/no exchange upgrade in progress/i);
    });

    it('should revert when upgrade was initiated and addresses mismatch', async () => {
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      await governance.initiateExchangeUpgrade(await newExchange.getAddress());
      await expect(
        governance.finalizeExchangeUpgrade(await governance.getAddress()),
      ).to.eventually.be.rejectedWith(/address mismatch/i);
    });

    it('should revert when block threshold not yet reached', async () => {
      const results = await deployAndAssociateContracts(
        ownerWallet,
        ownerWallet,
        ownerWallet,
        ownerWallet,
        ownerWallet,
        ownerWallet,
        100,
      );
      governance = results.governance;
      const newExchange = await ExchangeFactory.deploy(
        ethers.ZeroAddress,
        ownerWallet.address,
        ownerWallet.address,
        [await usdc.getAddress()],
        ownerWallet.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
      );

      await governance.initiateExchangeUpgrade(await newExchange.getAddress());
      await expect(
        governance.finalizeExchangeUpgrade(await newExchange.getAddress()),
      ).to.eventually.be.rejectedWith(/block threshold not yet reached/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .finalizeExchangeUpgrade(await governance.getAddress()),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('initiateGovernanceUpgrade', () => {
    let governance: Governance;
    let newGovernance: Governance;
    let ownerWallet: SignerWithAddress;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      governance = results.governance;
      newGovernance = await GovernanceFactory.deploy(0);
    });

    it('should work for valid contract address', async () => {
      await governance.initiateGovernanceUpgrade(
        await newGovernance.getAddress(),
      );
    });

    it('should revert for zero address', async () => {
      await expect(
        governance.initiateGovernanceUpgrade(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/invalid address/i);
    });

    it('should revert for non-contract address', async () => {
      await expect(
        governance.initiateGovernanceUpgrade(ownerWallet.address),
      ).to.eventually.be.rejectedWith(/invalid address/i);
    });

    it('should revert for same address as current', async () => {
      await expect(
        governance.initiateGovernanceUpgrade(await governance.getAddress()),
      ).to.eventually.be.rejectedWith(
        /must be different from current governance/i,
      );
    });

    it('should revert when upgrade is in progress', async () => {
      await governance.initiateGovernanceUpgrade(
        await newGovernance.getAddress(),
      );

      await expect(
        governance.initiateGovernanceUpgrade(await newGovernance.getAddress()),
      ).to.eventually.be.rejectedWith(
        /governance upgrade already in progress/i,
      );
    });

    it('should revert when not called by admin', async () => {
      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .initiateGovernanceUpgrade(await newGovernance.getAddress()),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('cancelGovernanceUpgrade', () => {
    let governance: Governance;
    let newGovernance: Governance;
    let ownerWallet: SignerWithAddress;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      governance = results.governance;
      newGovernance = await GovernanceFactory.deploy(0);
    });

    it('should work when upgrade was initiated', async () => {
      await governance.initiateGovernanceUpgrade(
        await newGovernance.getAddress(),
      );
      await governance.cancelGovernanceUpgrade();
    });

    it('should revert when no upgrade was initiated', async () => {
      await expect(
        governance.cancelGovernanceUpgrade(),
      ).to.eventually.be.rejectedWith(/no governance upgrade in progress/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .cancelGovernanceUpgrade(),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });

  describe('finalizeGovernanceUpgrade', () => {
    let governance: Governance;
    let newGovernance: Governance;
    let ownerWallet: SignerWithAddress;

    beforeEach(async () => {
      [ownerWallet] = await ethers.getSigners();
      const results = await deployAndAssociateContracts(ownerWallet);
      governance = results.governance;
      newGovernance = await GovernanceFactory.deploy(0);
    });

    it('should work when upgrade was initiated and addresses match', async () => {
      await governance.initiateGovernanceUpgrade(
        await newGovernance.getAddress(),
      );
      await governance.finalizeGovernanceUpgrade(
        await newGovernance.getAddress(),
      );
    });

    it('should revert when no upgrade was initiated', async () => {
      await expect(
        governance.finalizeGovernanceUpgrade(ethers.ZeroAddress),
      ).to.eventually.be.rejectedWith(/no governance upgrade in progress/i);
    });

    it('should revert when upgrade was initiated and addresses mismatch', async () => {
      await governance.initiateGovernanceUpgrade(
        await newGovernance.getAddress(),
      );
      await expect(
        governance.finalizeGovernanceUpgrade(await governance.getAddress()),
      ).to.eventually.be.rejectedWith(/address mismatch/i);
    });

    it('should revert when block threshold not yet reached', async () => {
      const results = await deployAndAssociateContracts(
        ownerWallet,
        ownerWallet,
        ownerWallet,
        ownerWallet,
        ownerWallet,
        ownerWallet,
        100,
      );
      governance = results.governance;

      await governance.initiateGovernanceUpgrade(
        await newGovernance.getAddress(),
      );
      await expect(
        governance.finalizeGovernanceUpgrade(await newGovernance.getAddress()),
      ).to.eventually.be.rejectedWith(/block threshold not yet reached/i);
    });

    it('should revert when not called by admin', async () => {
      await expect(
        governance
          .connect((await ethers.getSigners())[1])
          .finalizeGovernanceUpgrade(await governance.getAddress()),
      ).to.eventually.be.rejectedWith(/caller must be admin/i);
    });
  });
});
