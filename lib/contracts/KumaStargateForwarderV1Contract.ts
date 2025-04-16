import { ethers } from 'ethers';

import { KumaStargateForwarder_v1__factory } from '../../typechain-types';

import BaseContract from './BaseContract';
import * as utils from './utils';

import type { KumaStargateForwarder_v1 } from '../../typechain-types';

export default class KumaStargateForwarderV1Contract extends BaseContract<KumaStargateForwarder_v1> {
  public constructor(address: string, signerWalletPrivateKey?: string) {
    super(
      KumaStargateForwarder_v1__factory.connect(
        address,
        signerWalletPrivateKey
          ? new ethers.Wallet(signerWalletPrivateKey, utils.loadProvider())
          : utils.loadProvider(),
      ),
    );
  }

  public static async deploy(
    args: Parameters<KumaStargateForwarder_v1__factory['deploy']>,
    libraryAddresses: {
      kumaStargateForwarderComposing: string;
    },
    ownerWalletPrivateKey: string,
  ): Promise<KumaStargateForwarderV1Contract> {
    const linkLibraryAddresses: ConstructorParameters<
      typeof KumaStargateForwarder_v1__factory
    >[0] = {
      ['contracts/bridge-adapters/KumaStargateForwarderComposing.sol:KumaStargateForwarderComposing']:
        libraryAddresses.kumaStargateForwarderComposing,
    };
    const owner = new ethers.Wallet(
      ownerWalletPrivateKey,
      utils.loadProvider(),
    );

    const contract = await new KumaStargateForwarder_v1__factory(
      linkLibraryAddresses,
      owner,
    ).deploy(...args);

    return new this(await (await contract.waitForDeployment()).getAddress());
  }

  public getEthersContract(): KumaStargateForwarder_v1 {
    return this.contract;
  }
}
