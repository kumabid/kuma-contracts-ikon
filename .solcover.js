module.exports = {
  istanbulReporter: ['json-summary', 'html', 'text'],
  mocha: {
    enableTimeouts: false,
  },
  matrixOutputPath: './coverage/testMatrix.json',
  mochaJsonOutputPath: './coverage/mochaOutput.json',
  skipFiles: [
    'bridge-adapters/ExchangeLayerZeroAdapter.sol',
    'bridge-adapters/ExchangeLayerZeroAdapter_v2.sol',
    'bridge-adapters/KumaStargateForwarder_v1.sol',
    'bridge-adapters/KumaStargateForwarderComposing.sol',
    'bridge-adapters/LayerZeroFeeEstimation.sol',
    'test/OraclePriceAdapterMock.sol',
    'test/StargateV2PoolMock.sol',
    'util/ExchangeWalletStateAggregator.sol',
  ],
};
