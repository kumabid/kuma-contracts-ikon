module.exports = {
  istanbulReporter: ['json-summary', 'html', 'text'],
  mocha: {
    enableTimeouts: false,
  },
  matrixOutputPath: './coverage/testMatrix.json',
  mochaJsonOutputPath: './coverage/mochaOutput.json',
  skipFiles: [
    'bridge-adapters/ExchangeLayerZeroAdapter.sol',
    'test/OraclePriceAdapterMock.sol',
    'test/StargateV2PoolMock.sol',
    'util/ExchangeWalletStateAggregator.sol',
  ],
};
