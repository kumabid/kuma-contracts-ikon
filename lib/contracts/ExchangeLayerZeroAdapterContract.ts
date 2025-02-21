import { ethers } from 'ethers';

import {
  ExchangeLayerZeroAdapter__factory,
} from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type {
  ExchangeLayerZeroAdapter} from '../../typechain-types';

export default class ExchangeLayerZeroAdapterContract extends BaseContract<ExchangeLayerZeroAdapter> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      ExchangeLayerZeroAdapter__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<ExchangeLayerZeroAdapter__factory['deploy']>,
    ownerWalletPrivateKey: string,
  ): Promise<ExchangeLayerZeroAdapterContract> {
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new ExchangeLayerZeroAdapter__factory(owner).deploy(
      ...args,
    );

    return new this(await (await contract.waitForDeployment()).getAddress());
  }

  public getEthersContract(): ExchangeLayerZeroAdapter {
    return this.contract;
  }
}
