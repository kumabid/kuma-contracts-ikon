import { time } from '@nomicfoundation/hardhat-network-helpers';
import { ethers, network } from 'hardhat';
import { v1 as uuidv1 } from 'uuid';

import {
  decimalToAssetUnits,
  decimalToPips,
  Withdrawal,
  fieldUpgradeDelayInS,
  getWithdrawArguments,
  getWithdrawalSignatureTypedData,
} from '../lib';

import {
  deployAndAssociateContracts,
  expect,
  quoteAssetDecimals,
} from './helpers';

import type {
  Custodian,
  Exchange_v1,
  ExchangeLayerZeroAdapter__factory,
  USDC,
  StargateV2PoolMock,
  Governance,
  ExchangeLayerZeroAdapter,
} from '../typechain-types';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

describe('bridge-adapters', function () {
  describe('ExchangeLayerZeroAdapter', function () {
    let custodian: Custodian;
    let dispatcherWallet: SignerWithAddress;
    let exchange: Exchange_v1;
    let ExchangeLayerZeroAdapterFactory: ExchangeLayerZeroAdapter__factory;
    let governance: Governance;
    let ownerWallet: SignerWithAddress;
    let stargatePoolMock: StargateV2PoolMock;
    let traderWallet: SignerWithAddress;
    let usdc: USDC;

    const sendFee = ethers.parseEther('0.0001');

    before(async () => {
      await network.provider.send('hardhat_reset');
    });

    beforeEach(async () => {
      const wallets = await ethers.getSigners();

      ownerWallet = wallets[0];
      dispatcherWallet = wallets[1];
      traderWallet = wallets[6];
      const results = await deployAndAssociateContracts(
        ownerWallet,
        dispatcherWallet,
        wallets[2],
        wallets[3],
        wallets[4],
        wallets[5],
      );
      custodian = results.custodian;
      exchange = results.exchange;
      governance = results.governance;
      usdc = results.usdc;

      await usdc.transfer(
        traderWallet.address,
        decimalToAssetUnits('1000.00000000', quoteAssetDecimals),
      );

      ExchangeLayerZeroAdapterFactory = await ethers.getContractFactory(
        'ExchangeLayerZeroAdapter',
      );
      stargatePoolMock = await (
        await ethers.getContractFactory('StargateV2PoolMock')
      ).deploy(sendFee, await usdc.getAddress());
    });

    describe('deploy', async function () {
      it('should work for valid arguments', async () => {
        await ExchangeLayerZeroAdapterFactory.deploy(
          await custodian.getAddress(),
          decimalToPips('0.99900000'),
          await stargatePoolMock.getAddress(),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
        );
      });

      it('should revert for invalid Custodian address', async () => {
        await expect(
          ExchangeLayerZeroAdapterFactory.deploy(
            ethers.ZeroAddress,
            decimalToPips('0.99900000'),
            await stargatePoolMock.getAddress(),
            await stargatePoolMock.getAddress(),
            await usdc.getAddress(),
          ),
        ).to.eventually.be.rejectedWith(/invalid custodian address/i);
      });

      it('should revert for invalid OFT address', async () => {
        await expect(
          ExchangeLayerZeroAdapterFactory.deploy(
            await custodian.getAddress(),
            decimalToPips('0.99900000'),
            await stargatePoolMock.getAddress(),
            ethers.ZeroAddress,
            await usdc.getAddress(),
          ),
        ).to.eventually.be.rejectedWith(/invalid oft address/i);
      });

      it('should revert for invalid LZ endpoint address', async () => {
        await expect(
          ExchangeLayerZeroAdapterFactory.deploy(
            await custodian.getAddress(),
            decimalToPips('0.99900000'),
            ethers.ZeroAddress,
            await stargatePoolMock.getAddress(),
            await usdc.getAddress(),
          ),
        ).to.eventually.be.rejectedWith(/invalid lz endpoint address/i);
      });

      it('should revert for invalid quote asset address', async () => {
        await expect(
          ExchangeLayerZeroAdapterFactory.deploy(
            await custodian.getAddress(),
            decimalToPips('0.99900000'),
            await stargatePoolMock.getAddress(),
            await stargatePoolMock.getAddress(),
            ethers.ZeroAddress,
          ),
        ).to.eventually.be.rejectedWith(/invalid quote asset address/i);
      });
    });

    describe('lzCompose', async function () {
      it('should work for valid arguments', async () => {
        const depositQuantityInDecimal = '5.00000000';
        const depositQuantityInAssetUnits = ethers.parseUnits(
          depositQuantityInDecimal,
          quoteAssetDecimals,
        );
        const composeMessage = ethers.solidityPacked(
          ['uint64', 'uint32', 'uint256', 'bytes'],
          [
            0,
            1,
            depositQuantityInAssetUnits,
            ethers.solidityPacked(
              ['bytes', 'bytes'],
              [
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ['address'],
                  [traderWallet.address],
                ),
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ['address'],
                  [traderWallet.address],
                ),
              ],
            ),
          ],
        );

        const bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
          await custodian.getAddress(),
          decimalToPips('0.99900000'),
          await stargatePoolMock.getAddress(),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
        );
        await bridgeAdapter.setDepositEnabled(true);

        await usdc.transfer(
          await bridgeAdapter.getAddress(),
          depositQuantityInAssetUnits,
        );

        await stargatePoolMock.lzCompose(
          await bridgeAdapter.getAddress(),
          await stargatePoolMock.getAddress(),
          ethers.randomBytes(32),
          composeMessage,
          await stargatePoolMock.getAddress(),
          '0x',
        );

        const composeFailedEvents = await bridgeAdapter.queryFilter(
          bridgeAdapter.filters.LzComposeFailed(),
        );
        expect(composeFailedEvents).to.have.lengthOf(0);

        const depositedEvents = await exchange.queryFilter(
          exchange.filters.Deposited(),
        );

        expect(depositedEvents).to.have.lengthOf(1);
        expect(depositedEvents[0].args?.index).to.equal(1);
        expect(depositedEvents[0].args?.quantity).to.equal(
          decimalToPips(depositQuantityInDecimal),
        );
      });

      it('should return tokens to destination wallet when deposits are disabled in adapter', async () => {
        const depositQuantityInDecimal = '5.00000000';
        const depositQuantityInAssetUnits = ethers.parseUnits(
          depositQuantityInDecimal,
          quoteAssetDecimals,
        );
        const composeMessage = ethers.solidityPacked(
          ['uint64', 'uint32', 'uint256', 'bytes'],
          [
            0,
            1,
            depositQuantityInAssetUnits,
            ethers.solidityPacked(
              ['bytes', 'bytes'],
              [
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ['address'],
                  [traderWallet.address],
                ),
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ['address'],
                  [traderWallet.address],
                ),
              ],
            ),
          ],
        );

        const bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
          await custodian.getAddress(),
          decimalToPips('0.99900000'),
          await stargatePoolMock.getAddress(),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
        );

        await usdc.transfer(
          await bridgeAdapter.getAddress(),
          depositQuantityInAssetUnits,
        );

        await stargatePoolMock.lzCompose(
          await bridgeAdapter.getAddress(),
          await stargatePoolMock.getAddress(),
          ethers.randomBytes(32),
          composeMessage,
          await stargatePoolMock.getAddress(),
          '0x',
        );

        const composeFailedEvents = await bridgeAdapter.queryFilter(
          bridgeAdapter.filters.LzComposeFailed(),
        );
        expect(composeFailedEvents).to.have.lengthOf(1);
        expect(composeFailedEvents[0].args?.destinationWallet).to.equal(
          traderWallet.address,
        );
        expect(composeFailedEvents[0].args?.quantity).to.equal(
          depositQuantityInAssetUnits,
        );
        expect(
          ethers.toUtf8String(composeFailedEvents[0].args?.errorData),
        ).to.match(/deposits disabled/i);

        const transferEvents = await usdc.queryFilter(usdc.filters.Transfer());
        const lastTransferEvent = transferEvents[transferEvents.length - 1];
        expect(lastTransferEvent.args?.from).to.equal(
          await bridgeAdapter.getAddress(),
        );
        expect(lastTransferEvent.args?.to).to.equal(traderWallet.address);
        expect(lastTransferEvent.args?.value).to.equal(
          depositQuantityInAssetUnits,
        );

        await expect(usdc.balanceOf(bridgeAdapter)).to.eventually.equal(
          BigInt(0),
        );
      });

      it('should return tokens to destination wallet when deposits are disabled in Exchange', async () => {
        const depositQuantityInDecimal = '5.00000000';
        const depositQuantityInAssetUnits = ethers.parseUnits(
          depositQuantityInDecimal,
          quoteAssetDecimals,
        );
        const composeMessage = ethers.solidityPacked(
          ['uint64', 'uint32', 'uint256', 'bytes'],
          [
            0,
            1,
            depositQuantityInAssetUnits,
            ethers.solidityPacked(
              ['bytes', 'bytes'],
              [
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ['address'],
                  [traderWallet.address],
                ),
                ethers.AbiCoder.defaultAbiCoder().encode(
                  ['address'],
                  [traderWallet.address],
                ),
              ],
            ),
          ],
        );

        const bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
          await custodian.getAddress(),
          decimalToPips('0.99900000'),
          await stargatePoolMock.getAddress(),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
        );
        await bridgeAdapter.setDepositEnabled(true);

        await exchange.setDepositEnabled(false);

        await usdc.transfer(
          await bridgeAdapter.getAddress(),
          depositQuantityInAssetUnits,
        );

        await stargatePoolMock.lzCompose(
          await bridgeAdapter.getAddress(),
          await stargatePoolMock.getAddress(),
          ethers.randomBytes(32),
          composeMessage,
          await stargatePoolMock.getAddress(),
          '0x',
        );

        const composeFailedEvents = await bridgeAdapter.queryFilter(
          bridgeAdapter.filters.LzComposeFailed(),
        );
        expect(composeFailedEvents).to.have.lengthOf(1);
        expect(composeFailedEvents[0].args?.destinationWallet).to.equal(
          traderWallet.address,
        );
        expect(composeFailedEvents[0].args?.quantity).to.equal(
          depositQuantityInAssetUnits,
        );

        const transferEvents = await usdc.queryFilter(usdc.filters.Transfer());
        const lastTransferEvent = transferEvents[transferEvents.length - 1];
        expect(lastTransferEvent.args?.from).to.equal(
          await bridgeAdapter.getAddress(),
        );
        expect(lastTransferEvent.args?.to).to.equal(traderWallet.address);
        expect(lastTransferEvent.args?.value).to.equal(
          depositQuantityInAssetUnits,
        );

        await expect(usdc.balanceOf(bridgeAdapter)).to.eventually.equal(
          BigInt(0),
        );
      });
    });

    describe('withdrawQuoteAsset', async function () {
      let bridgeAdapter: ExchangeLayerZeroAdapter;
      let signature: string;
      let withdrawal: Withdrawal;

      beforeEach(async () => {
        bridgeAdapter = await ExchangeLayerZeroAdapterFactory.deploy(
          await custodian.getAddress(),
          decimalToPips('0.99900000'),
          await stargatePoolMock.getAddress(),
          await stargatePoolMock.getAddress(),
          await usdc.getAddress(),
        );

        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);
        await time.increase(fieldUpgradeDelayInS);
        await governance.finalizeBridgeAdaptersUpgrade([
          await bridgeAdapter.getAddress(),
        ]);

        await bridgeAdapter.setWithdrawEnabled(true);

        const depositQuantity = ethers.parseUnits('5.0', quoteAssetDecimals);
        await usdc.transfer(traderWallet.address, depositQuantity);
        await usdc
          .connect(traderWallet)
          .approve(await exchange.getAddress(), depositQuantity);
        await exchange
          .connect(traderWallet)
          .deposit(depositQuantity, ethers.ZeroAddress);
        await exchange
          .connect(dispatcherWallet)
          .applyPendingDepositsForWallet(
            decimalToPips('5.00000000'),
            traderWallet.address,
          );

        withdrawal = {
          nonce: uuidv1(),
          wallet: traderWallet.address,
          quantity: '1.00000000',
          maximumGasFee: '0.10000000',
          bridgeAdapter: await bridgeAdapter.getAddress(),
          bridgeAdapterPayload: ethers.AbiCoder.defaultAbiCoder().encode(
            ['uint32'],
            [1],
          ),
        };
        signature = await traderWallet.signTypedData(
          ...getWithdrawalSignatureTypedData(
            withdrawal,
            await exchange.getAddress(),
          ),
        );
      });

      it('should work for valid arguments when adapter is funded', async () => {
        await ownerWallet.sendTransaction({
          to: await bridgeAdapter.getAddress(),
          value: sendFee,
        });

        await exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.00000000', signature),
          );
      });

      it('should work with fallback for valid arguments when adapter is not funded', async () => {
        await exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.00000000', signature),
          );
      });

      it('should work for when multiple adapters are whitelisted', async () => {
        await ownerWallet.sendTransaction({
          to: await bridgeAdapter.getAddress(),
          value: sendFee,
        });

        ExchangeLayerZeroAdapterFactory = await ethers.getContractFactory(
          'ExchangeLayerZeroAdapter',
        );
        const bridgeAdapter2 = await (
          await ethers.getContractFactory('StargateV2PoolMock')
        ).deploy(sendFee, await usdc.getAddress());

        await governance.initiateBridgeAdaptersUpgrade([
          await bridgeAdapter2.getAddress(),
          await bridgeAdapter.getAddress(),
        ]);
        await time.increase(fieldUpgradeDelayInS);
        await governance.finalizeBridgeAdaptersUpgrade([
          await bridgeAdapter2.getAddress(),
          await bridgeAdapter.getAddress(),
        ]);

        await exchange
          .connect(dispatcherWallet)
          .withdraw(
            ...getWithdrawArguments(withdrawal, '0.00000000', signature),
          );
      });
    });
  });
});
