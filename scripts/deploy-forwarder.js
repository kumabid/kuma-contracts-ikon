const { ethers } = require('hardhat');

async function main() {
  const deployWallet = new ethers.Wallet(
    process.env.DEPLOY_WALLET_PRIVATE_KEY,
  ).connect(
    new ethers.JsonRpcProvider(
      process.env.RPC_URL,
      parseInt(process.env.CHAIN_ID, 10),
    ),
  );

  const KumaStargateForwarderComposingFactory = (
    await ethers.getContractFactory('KumaStargateForwarderComposing')
  ).connect(deployWallet);
  const kumaStargateForwarderComposing =
    await KumaStargateForwarderComposingFactory.deploy();
  await kumaStargateForwarderComposing.waitForDeployment();

  const KumaStargateForwarderFactory = (
    await ethers.getContractFactory('KumaStargateForwarder_v1', {
      libraries: {
        KumaStargateForwarderComposing:
          await kumaStargateForwarderComposing.getAddress(),
      },
    })
  ).connect(deployWallet);
  const forwarder = await KumaStargateForwarderFactory.deploy(
    process.env.EXCHANGE_LAYERZERO_ADAPTER,
    process.env.LZ_ENDPOINT,
    process.env.MINIMUM_FORWARD_QUANTITY_MULTIPLIER,
    process.env.MINIMUM_DEPOSIT_NATIVE_DROP_QUANTITY_MULTIPLIER,
    process.env.OFT,
    process.env.STARGATE,
    process.env.USDC,
    process.env.XCHAIN_ENDPOINT_ID,
  );

  await forwarder.waitForDeployment();
  console.log('Forwarder deployed to:', await forwarder.getAddress());
}

main();
