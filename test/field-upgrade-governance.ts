import { expect } from 'chai';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, network } from 'hardhat';

import { Exchange_v1__factory, type StargateV2PoolMock } from '../typechain-types';

import { fieldUpgradeDelayInS } from '../lib';
import {
  baseAssetSymbol,
  bootstrapLiquidatedWallet,
  buildIndexPrice,
  deployAndAssociateContracts,
  executeTrade,
  fundWallets,
} from './helpers';
import type {
  ChainlinkOraclePriceAdapter,
  Custodian,
  Exchange_v1,
  ExchangeLayerZeroAdapter,
  ExchangeLayerZeroAdapter__factory,
  Governance,
  USDC,
  KumaIndexAndOraclePriceAdapter,
} from '../typechain-types';

describe('Governance', function () {
  let custodian: Custodian;
  let dispatcherWallet: SignerWithAddress;
  let exchange: Exchange_v1;
  let ExchangeFactory: Exchange_v1__factory;
  let indexPriceAdapter: KumaIndexAndOraclePriceAdapter;
  let indexPriceServiceWallet: SignerWithAddress;
  let insuranceFundWallet: SignerWithAddress;
  let governance: Governance;
  let ownerWallet: SignerWithAddress;
  let usdc: USDC;

  before(async () => {
    await network.provider.send('hardhat_reset');
  });

  beforeEach(async () => {
    const wallets = await ethers.getSigners();
    ownerWallet = wallets[0];
    dispatcherWallet = wallets[1];
    indexPriceServiceWallet = wallets[4];
    insuranceFundWallet = wallets[5];
    const [, , exitFundWallet, feeWallet] = wallets;

    const results = await deployAndAssociateContracts(
      ownerWallet,
      dispatcherWallet,
      exitFundWallet,
      feeWallet,
      indexPriceServiceWallet,
      insuranceFundWallet,
    );

    custodian = results.custodian;
    exchange = results.exchange;
    ExchangeFactory = results.ExchangeFactory;
    governance = results.governance;
    indexPriceAdapter = results.indexPriceAdapter;
    usdc = results.usdc;
  });

  describe('bridge adapters upgrade', () => {
    let bridgeAdapter: ExchangeLayerZeroAdapter;
    let ExchangeLayerZeroAdapterFactory: ExchangeLayerZeroAdapter__factory;
    let stargatePoolMock: StargateV2PoolMock;

    beforeEach(async () => {
      ExchangeLayerZeroAdapterFactory = await ethers.getContractFactory(
        'ExchangeLayerZeroAdapter',
      );
      stargatePoolMock = await (
        await ethers.getContractFactory('StargateV2PoolMock')
      ).deploy(0, await usdc.getAddress());

      bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
        await custodian.getAddress(),
        99900000,
        await stargatePoolMock.getAddress(),
        await stargatePoolMock.getAddress(),
        await usdc.getAddress(),
      );
    });

    describe('initiateBridgeAdaptersUpgrade', () => {
      it('should work for valid contract address', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);
        expect(
          governance.queryFilter(
            governance.filters.BridgeAdaptersUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for invalid address', async () => {
        await expect(
          governance.initiateBridgeAdaptersUpgrade([
            (await ethers.getSigners())[0].address,
          ]),
        ).to.eventually.be.rejectedWith(/invalid adapter address/i);
      });

      it('should revert when already in progress', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await expect(
          governance.initiateBridgeAdaptersUpgrade([
            await bridgeAdapter.getAddress(),
          ]),
        ).to.eventually.be.rejectedWith(/already in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .initiateBridgeAdaptersUpgrade([await bridgeAdapter.getAddress()]),
        ).to.eventually.be.rejectedWith(/caller must be admin wallet/i);
      });
    });

    describe('cancelBridgeAdaptersUpgrade', () => {
      it('should work when in progress', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);
        await governance.cancelBridgeAdaptersUpgrade();
        expect(
          governance.queryFilter(
            governance.filters.BridgeAdaptersUpgradeCanceled(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.cancelBridgeAdaptersUpgrade(),
        ).to.eventually.be.rejectedWith(/no adapter upgrade in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .cancelBridgeAdaptersUpgrade(),
        ).to.eventually.be.rejectedWith(/caller must be admin wallet/i);
      });
    });

    describe('finalizeBridgeAdaptersUpgrade', async () => {
      it('should work after block delay when upgrade was initiated', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);
        expect(
          governance.queryFilter(
            governance.filters.BridgeAdaptersUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should be applied to current Exchange contract following an upgrade', async () => {
        const newExchange = await ExchangeFactory.deploy(
          ethers.ZeroAddress,
          ownerWallet.address,
          ownerWallet.address,
          [await usdc.getAddress()],
          ownerWallet.address,
          await usdc.getAddress(),
          await usdc.getAddress(),
        );
        await newExchange.setCustodian(await custodian.getAddress(), []);

        await governance.initiateExchangeUpgrade(
          await newExchange.getAddress(),
        );
        await governance.finalizeExchangeUpgrade(
          await newExchange.getAddress(),
        );

        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await expect(newExchange.bridgeAdapters(0)).to.eventually.equal(
          await bridgeAdapter.getAddress(),
        );
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.finalizeBridgeAdaptersUpgrade([
            await bridgeAdapter.getAddress(),
          ]),
        ).to.eventually.be.rejectedWith(/no adapter upgrade in progress/i);
      });

      it('should revert before block delay', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await expect(
          governance.finalizeBridgeAdaptersUpgrade([
            await bridgeAdapter.getAddress(),
          ]),
        ).to.eventually.be.rejectedWith(
          /block timestamp threshold not yet reached/i,
        );
      });

      it('should revert on address length mismatch', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeBridgeAdaptersUpgrade([
            await bridgeAdapter.getAddress(),
            ownerWallet.address,
          ]),
        ).to.eventually.be.rejectedWith(/address mismatch/i);
      });

      it('should revert on address  mismatch', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeBridgeAdaptersUpgrade([ownerWallet.address]),
        ).to.eventually.be.rejectedWith(/address mismatch/i);
      });

      it('should revert when not called by admin or dispatcher', async () => {
        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .finalizeBridgeAdaptersUpgrade([await bridgeAdapter.getAddress()]),
        ).to.eventually.be.rejectedWith(
          /caller must be admin or dispatcher wallet/i,
        );
      });
    });

    describe('Index Price Adapter upgrade', () => {
      let newIndexPriceAdapter: KumaIndexAndOraclePriceAdapter;

      beforeEach(async () => {
        newIndexPriceAdapter = await (
          await (
            await ethers.getContractFactory('KumaIndexAndOraclePriceAdapter')
          ).deploy(await governance.getAddress(), [
            indexPriceServiceWallet.address,
          ])
        ).waitForDeployment();
      });

      describe('initiateIndexPriceAdaptersUpgrade', () => {
        it('should work for valid wallet address', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);
          expect(
            governance.queryFilter(
              governance.filters.IndexPriceAdaptersUpgradeInitiated(),
            ),
          )
            .to.eventually.be.an('array')
            .with.lengthOf(1);
        });

        it('should revert for invalid address', async () => {
          await expect(
            governance.initiateIndexPriceAdaptersUpgrade([ethers.ZeroAddress]),
          ).to.eventually.be.rejectedWith(
            /invalid index price adapter address/i,
          );
        });

        it('should revert when already in progress', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await expect(
            governance.initiateIndexPriceAdaptersUpgrade([
              await newIndexPriceAdapter.getAddress(),
            ]),
          ).to.eventually.be.rejectedWith(/already in progress/i);
        });

        it('should revert when not called by admin', async () => {
          await expect(
            governance
              .connect((await ethers.getSigners())[5])
              .initiateIndexPriceAdaptersUpgrade([
                await newIndexPriceAdapter.getAddress(),
              ]),
          ).to.eventually.be.rejectedWith(/caller must be admin wallet/i);
        });
      });

      describe('cancelIndexPriceAdaptersUpgrade', () => {
        it('should work when in progress', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);
          await governance.cancelIndexPriceAdaptersUpgrade();
          expect(
            governance.queryFilter(
              governance.filters.IndexPriceAdaptersUpgradeCanceled(),
            ),
          )
            .to.eventually.be.an('array')
            .with.lengthOf(1);
        });

        it('should revert when not in progress', async () => {
          await expect(
            governance.cancelIndexPriceAdaptersUpgrade(),
          ).to.eventually.be.rejectedWith(
            /no index price adapter upgrade in progress/i,
          );
        });

        it('should revert when not called by admin', async () => {
          await expect(
            governance
              .connect((await ethers.getSigners())[5])
              .cancelIndexPriceAdaptersUpgrade(),
          ).to.eventually.be.rejectedWith(/caller must be admin wallet/i);
        });
      });

      describe('finalizeIndexPriceAdaptersUpgrade', async () => {
        it('should work when in progress', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await time.increase(fieldUpgradeDelayInS);

          await governance.finalizeIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);
          expect(
            governance.queryFilter(
              governance.filters.IndexPriceAdaptersUpgradeFinalized(),
            ),
          )
            .to.eventually.be.an('array')
            .with.lengthOf(1);
        });

        it('should revert when not in progress', async () => {
          await expect(
            governance.finalizeIndexPriceAdaptersUpgrade([
              await newIndexPriceAdapter.getAddress(),
            ]),
          ).to.eventually.be.rejectedWith(
            /no index price adapter upgrade in progress/i,
          );
        });

        it('should revert before block delay', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await expect(
            governance.finalizeIndexPriceAdaptersUpgrade([
              await newIndexPriceAdapter.getAddress(),
            ]),
          ).to.eventually.be.rejectedWith(
            /block timestamp threshold not yet reached/i,
          );
        });

        it('should revert on address length mismatch', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await time.increase(fieldUpgradeDelayInS);

          await expect(
            governance.finalizeIndexPriceAdaptersUpgrade([
              await newIndexPriceAdapter.getAddress(),
              await newIndexPriceAdapter.getAddress(),
            ]),
          ).to.eventually.be.rejectedWith(/address mismatch/i);
        });

        it('should revert on address mismatch', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await time.increase(fieldUpgradeDelayInS);

          await expect(
            governance.finalizeIndexPriceAdaptersUpgrade([ownerWallet.address]),
          ).to.eventually.be.rejectedWith(/address mismatch/i);
        });

        it('should revert when not called by admin or dispatcher', async () => {
          await governance.initiateIndexPriceAdaptersUpgrade([
            await newIndexPriceAdapter.getAddress(),
          ]);

          await expect(
            governance
              .connect((await ethers.getSigners())[10])
              .finalizeIndexPriceAdaptersUpgrade([
                await newIndexPriceAdapter.getAddress(),
              ]),
          ).to.eventually.be.rejectedWith(
            /caller must be admin or dispatcher wallet/i,
          );
        });
      });
    });
  });

  describe('Oracle Price Adapter upgrade', () => {
    let newOraclePriceAdapter: ChainlinkOraclePriceAdapter;

    beforeEach(async () => {
      const [ChainlinkAggregatorFactory, ChainlinkOraclePriceAdapter] =
        await Promise.all([
          ethers.getContractFactory('ChainlinkAggregatorMock'),
          ethers.getContractFactory('ChainlinkOraclePriceAdapter'),
        ]);

      const chainlinkAggregator = await (
        await ChainlinkAggregatorFactory.deploy()
      ).waitForDeployment();

      newOraclePriceAdapter = await (
        await ChainlinkOraclePriceAdapter.deploy(
          [baseAssetSymbol],
          [await chainlinkAggregator.getAddress()],
        )
      ).waitForDeployment();
    });

    describe('initiateOraclePriceAdapterUpgrade', () => {
      it('should work for valid wallet address', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );
        expect(
          governance.queryFilter(
            governance.filters.OraclePriceAdapterUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for invalid address', async () => {
        await expect(
          governance.initiateOraclePriceAdapterUpgrade(ethers.ZeroAddress),
        ).to.eventually.be.rejectedWith(
          /invalid oracle price adapter address/i,
        );
      });

      it('should revert when already in progress', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await expect(
          governance.initiateOraclePriceAdapterUpgrade(
            await newOraclePriceAdapter.getAddress(),
          ),
        ).to.eventually.be.rejectedWith(/already in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .initiateOraclePriceAdapterUpgrade(
              await newOraclePriceAdapter.getAddress(),
            ),
        ).to.eventually.be.rejectedWith(/caller must be admin wallet/i);
      });
    });

    describe('cancelOraclePriceAdapterUpgrade', () => {
      it('should work when in progress', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );
        await governance.cancelOraclePriceAdapterUpgrade();
        expect(
          governance.queryFilter(
            governance.filters.OraclePriceAdapterUpgradeCanceled(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.cancelOraclePriceAdapterUpgrade(),
        ).to.eventually.be.rejectedWith(
          /no oracle price adapter upgrade in progress/i,
        );
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .cancelOraclePriceAdapterUpgrade(),
        ).to.eventually.be.rejectedWith(/caller must be admin wallet/i);
      });
    });

    describe('finalizeOraclePriceAdapterUpgrade', async () => {
      it('should work when in progress', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );
        expect(
          governance.queryFilter(
            governance.filters.OraclePriceAdapterUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.finalizeOraclePriceAdapterUpgrade(
            await newOraclePriceAdapter.getAddress(),
          ),
        ).to.eventually.be.rejectedWith(
          /no oracle price adapter upgrade in progress/i,
        );
      });

      it('should revert before block delay', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await expect(
          governance.finalizeOraclePriceAdapterUpgrade(
            await newOraclePriceAdapter.getAddress(),
          ),
        ).to.eventually.be.rejectedWith(
          /block timestamp threshold not yet reached/i,
        );
      });

      it('should revert on address mismatch', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeOraclePriceAdapterUpgrade(ownerWallet.address),
        ).to.eventually.be.rejectedWith(/address mismatch/i);
      });

      it('should revert when not called by admin or dispatcher', async () => {
        await governance.initiateOraclePriceAdapterUpgrade(
          await newOraclePriceAdapter.getAddress(),
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .finalizeOraclePriceAdapterUpgrade(ownerWallet.address),
        ).to.eventually.be.rejectedWith(
          /caller must be admin or dispatcher wallet/i,
        );
      });
    });
  });

  describe('IF wallet upgrade', () => {
    describe('initiateInsuranceFundWalletUpgrade', () => {
      let newInsuranceFundWallet: SignerWithAddress;

      beforeEach(async () => {
        [newInsuranceFundWallet] = await ethers.getSigners();
      });

      it('should work for valid wallet address', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        expect(
          governance.queryFilter(
            governance.filters.InsuranceFundWalletUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for zero address', async () => {
        await expect(
          governance.initiateInsuranceFundWalletUpgrade(ethers.ZeroAddress),
        ).to.eventually.be.rejectedWith(/invalid IF wallet address/i);
      });

      it('should revert if new IF is same as current', async () => {
        await expect(
          governance.initiateInsuranceFundWalletUpgrade(
            insuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(/must be different from current/i);
      });

      it('should revert when upgrade already in progress', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );
        await expect(
          governance.initiateInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(/upgrade already in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[1])
            .initiateInsuranceFundWalletUpgrade(newInsuranceFundWallet.address),
        ).to.eventually.be.rejectedWith(/caller must be admin/i);
      });
    });

    describe('cancelInsuranceFundWalletUpgrade', () => {
      let newInsuranceFundWallet: SignerWithAddress;

      beforeEach(async () => {
        [newInsuranceFundWallet] = await ethers.getSigners();
      });

      it('should work when in progress', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );
        await governance.cancelInsuranceFundWalletUpgrade();
        expect(
          governance.queryFilter(
            governance.filters.InsuranceFundWalletUpgradeCanceled(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.cancelInsuranceFundWalletUpgrade(),
        ).to.eventually.be.rejectedWith(/no IF wallet upgrade in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[5])
            .cancelInsuranceFundWalletUpgrade(),
        ).to.eventually.be.rejectedWith(/caller must be admin wallet/i);
      });
    });

    describe('finalizeInsuranceFundWalletUpgrade', () => {
      let newInsuranceFundWallet: SignerWithAddress;

      before(async () => {
        newInsuranceFundWallet = (await ethers.getSigners())[10];
      });

      it('should work after block delay when upgrade was initiated', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await expect(exchange.insuranceFundWallet()).to.eventually.equal(
          newInsuranceFundWallet.address,
        );
        expect(
          governance.queryFilter(
            governance.filters.InsuranceFundWalletUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(/no IF wallet upgrade in progress/i);
      });

      it('should revert on address  mismatch', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(ownerWallet.address),
        ).to.eventually.be.rejectedWith(/address mismatch/i);
      });

      it('should revert before block delay', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(
          /block timestamp threshold not yet reached/i,
        );
      });

      it('should revert when current IF has open position', async () => {
        const results = await bootstrapLiquidatedWallet();

        await results.governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          results.governance.finalizeInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(
          /current IF cannot have open positions/i,
        );
      });

      it('should revert when new IF has open position', async () => {
        const trader1Wallet = (await ethers.getSigners())[6];
        const trader2Wallet = (await ethers.getSigners())[7];
        await fundWallets(
          [trader1Wallet, trader2Wallet],
          dispatcherWallet,
          exchange,
          usdc,
        );
        await executeTrade(
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

        await governance.initiateInsuranceFundWalletUpgrade(
          trader1Wallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(trader1Wallet.address),
        ).to.eventually.be.rejectedWith(/new IF cannot have open positions/i);
      });

      it('should revert when new IF is exited', async () => {
        await governance.initiateInsuranceFundWalletUpgrade(
          newInsuranceFundWallet.address,
        );

        await time.increase(fieldUpgradeDelayInS);

        await exchange.connect(newInsuranceFundWallet).exitWallet();

        await expect(
          governance.finalizeInsuranceFundWalletUpgrade(
            newInsuranceFundWallet.address,
          ),
        ).to.eventually.be.rejectedWith(/IF wallet cannot be exited/i);
      });

      it('should revert when not called by admin or dispatcher', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .finalizeInsuranceFundWalletUpgrade(newInsuranceFundWallet.address),
        ).to.eventually.be.rejectedWith(
          /caller must be admin or dispatcher wallet/i,
        );
      });
    });
  });

  describe('market overrides upgrade', () => {
    const marketOverrides = {
      initialMarginFraction: '3000000',
      maintenanceMarginFraction: '1000000',
      incrementalInitialMarginFraction: '1000000',
      baselinePositionSize: '14000000000',
      incrementalPositionSize: '2800000000',
      maximumPositionSize: '1000000000000',
      minimumPositionSize: '10000000',
    };
    let walletToOverride: string;

    before(async () => {
      walletToOverride = (await ethers.getSigners())[10].address;
    });

    describe('initiateMarketOverridesUpgrade', () => {
      it('should work for valid wallet address', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        expect(
          governance.queryFilter(
            governance.filters.MarketOverridesUpgradeInitiated(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when upgrade already in progress', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await expect(
          governance.initiateMarketOverridesUpgrade(
            baseAssetSymbol,
            marketOverrides,
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(/upgrade already in progress/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[1])
            .initiateMarketOverridesUpgrade(
              baseAssetSymbol,
              marketOverrides,
              walletToOverride,
            ),
        ).to.eventually.be.rejectedWith(/caller must be admin/i);
      });
    });

    describe('cancelMarketOverridesUpgrade', () => {
      it('should work when in progress', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );
        await governance.cancelMarketOverridesUpgrade(
          baseAssetSymbol,
          walletToOverride,
        );
        expect(
          governance.queryFilter(
            governance.filters.MarketOverridesUpgradeCanceled(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.cancelMarketOverridesUpgrade(
            baseAssetSymbol,
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(
          /no market override upgrade in progress/i,
        );
      });

      it('should revert when not called by admin', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .cancelMarketOverridesUpgrade(baseAssetSymbol, walletToOverride),
        ).to.eventually.be.rejectedWith(/caller must be admin wallet/i);
      });
    });

    describe('finalizeMarketOverridesUpgrade', () => {
      it('should work after block delay when upgrade was initiated', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        expect(
          governance.queryFilter(
            governance.filters.MarketOverridesUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should work when wallet is zero', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          ethers.ZeroAddress,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          ethers.ZeroAddress,
        );

        expect(
          governance.queryFilter(
            governance.filters.MarketOverridesUpgradeFinalized(),
          ),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for invalid market ', async () => {
        await governance.initiateMarketOverridesUpgrade(
          'XYZ',
          marketOverrides,
          ethers.ZeroAddress,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeMarketOverridesUpgrade(
            'XYZ',
            marketOverrides,
            ethers.ZeroAddress,
          ),
        ).to.eventually.be.rejectedWith(/invalid market/i);
      });

      it('should revert when not in progress', async () => {
        await expect(
          governance.finalizeMarketOverridesUpgrade(
            baseAssetSymbol,
            marketOverrides,
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(
          /no market override upgrade in progress for wallet/i,
        );
      });

      it('should revert before block delay', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await expect(
          governance.finalizeMarketOverridesUpgrade(
            baseAssetSymbol,
            marketOverrides,
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(
          /block timestamp threshold not yet reached/i,
        );
      });

      it('should revert on field mismatch', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await time.increase(fieldUpgradeDelayInS);

        await expect(
          governance.finalizeMarketOverridesUpgrade(
            baseAssetSymbol,
            { ...marketOverrides, initialMarginFraction: '5000000' },
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(/overrides mismatch/i);
      });

      it('should revert when not called by admin or dispatcher', async () => {
        await expect(
          governance
            .connect((await ethers.getSigners())[10])
            .finalizeMarketOverridesUpgrade(
              baseAssetSymbol,
              marketOverrides,
              walletToOverride,
            ),
        ).to.eventually.be.rejectedWith(
          /caller must be admin or dispatcher wallet/i,
        );
      });
    });

    describe('unsetMarketOverridesForWallet', () => {
      it('should work for valid market and wallet when called by admin', async () => {
        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await exchange.unsetMarketOverridesForWallet(
          baseAssetSymbol,
          walletToOverride,
        );

        await expect(
          exchange.queryFilter(exchange.filters.MarketOverridesUnset()),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should work for valid market and wallet when called by dispatcher', async () => {
        await exchange.setDispatcher((await ethers.getSigners())[5].address);

        await governance.initiateMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await time.increase(fieldUpgradeDelayInS);

        await governance.finalizeMarketOverridesUpgrade(
          baseAssetSymbol,
          marketOverrides,
          walletToOverride,
        );

        await exchange
          .connect((await ethers.getSigners())[5])
          .unsetMarketOverridesForWallet(baseAssetSymbol, walletToOverride);

        await expect(
          exchange.queryFilter(exchange.filters.MarketOverridesUnset()),
        )
          .to.eventually.be.an('array')
          .with.lengthOf(1);
      });

      it('should revert for invalid market ', async () => {
        await expect(
          exchange.unsetMarketOverridesForWallet('XYZ', walletToOverride),
        ).to.eventually.be.rejectedWith(/invalid market/i);
      });

      it('should revert for zero wallet address ', async () => {
        await expect(
          exchange.unsetMarketOverridesForWallet(
            baseAssetSymbol,
            ethers.ZeroAddress,
          ),
        ).to.eventually.be.rejectedWith(/invalid wallet/i);
      });

      it('should revert for wallet with no overrides ', async () => {
        await expect(
          exchange.unsetMarketOverridesForWallet(
            baseAssetSymbol,
            walletToOverride,
          ),
        ).to.eventually.be.rejectedWith(/wallet has no overrides for market/i);
      });

      it('should revert when not called by admin', async () => {
        await expect(
          exchange
            .connect((await ethers.getSigners())[5])
            .unsetMarketOverridesForWallet(baseAssetSymbol, walletToOverride),
        ).to.eventually.be.rejectedWith(
          /caller must be admin or dispatcher wallet/i,
        );
      });
    });
  });
});
