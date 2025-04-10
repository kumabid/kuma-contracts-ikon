import { ethers } from 'ethers';

import { ExchangeLayerZeroAdapter_v2__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { ExchangeLayerZeroAdapter_v2 } from '../../typechain-types';

export default class ExchangeLayerZeroAdapterV2Contract extends BaseContract<ExchangeLayerZeroAdapter_v2> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      ExchangeLayerZeroAdapter_v2__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<ExchangeLayerZeroAdapter_v2__factory['deploy']>,
    ownerWalletPrivateKey: string,
  ): Promise<ExchangeLayerZeroAdapterV2Contract> {
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new ExchangeLayerZeroAdapter_v2__factory(
      owner,
    ).deploy(...args);

    return new this(await (await contract.waitForDeployment()).getAddress());
  }

  public getEthersContract(): ExchangeLayerZeroAdapter_v2 {
    return this.contract;
  }
}
