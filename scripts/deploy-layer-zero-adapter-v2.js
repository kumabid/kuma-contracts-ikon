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

  const ExchangeLayerZeroAdapterV2Factory = (
    await ethers.getContractFactory('ExchangeLayerZeroAdapter_v2')
  ).connect(deployWallet);
  const adapter = await ExchangeLayerZeroAdapterV2Factory.deploy(
    process.env.BERACHAIN_LZ_ENDPOINT_ID,
    process.env.EXCHANGE_ADDRESS,
    process.env.LZ_ENDPOINT,
    process.env.MINIMUM_WITHDRAWAL_QUANTITY_MULTIPLIER,
    process.env.OFT,
    process.env.OFT, // Quote token is same as OFT on XCHAIN
  );

  await adapter.waitForDeployment();
  console.log(
    'ExchangeLayerZeroAdapterV2 deployed to:',
    await adapter.getAddress(),
  );
}

main();
