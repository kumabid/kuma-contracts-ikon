import { ethers } from 'ethers';

import * as utils from './utils';
import BaseContract from './BaseContract';

import {
  KumaIndexAndOraclePriceAdapter,
  KumaIndexAndOraclePriceAdapter__factory,
} from '../../typechain-types';

export default class KumaIndexAndOraclePriceAdapterContract extends BaseContract<KumaIndexAndOraclePriceAdapter> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      KumaIndexAndOraclePriceAdapter__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<KumaIndexAndOraclePriceAdapter__factory['deploy']>,
    ownerWalletPrivateKey: string,
  ): Promise<KumaIndexAndOraclePriceAdapterContract> {
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new KumaIndexAndOraclePriceAdapter__factory(
      owner,
    ).deploy(...args);

    return new this(await (await contract.waitForDeployment()).getAddress());
  }

  public getEthersContract(): KumaIndexAndOraclePriceAdapter {
    return this.contract;
  }
}
