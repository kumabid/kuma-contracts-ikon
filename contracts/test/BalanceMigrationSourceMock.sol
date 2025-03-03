// SPDX-License-Identifier: MIT

pragma solidity 0.8.18;

import { Balance } from "../libraries/Structs.sol";

contract BalanceMigrationSourceMock {
  mapping(address => mapping(string => int64)) public balances;
  uint64 public depositIndex;

  constructor(uint64 depositIndex_) {
    depositIndex = depositIndex_;
  }

  function setBalanceBySymbol(address wallet, string calldata assetSymbol, int64 newBalance) external {
    balances[wallet][assetSymbol] = newBalance;
  }

  function loadBalanceStructBySymbol(
    address wallet,
    string calldata assetSymbol
  ) external view returns (Balance memory) {
    return
      Balance({ isMigrated: true, balance: balances[wallet][assetSymbol], lastUpdateTimestampInMs: 0, costBasis: 0 });
  }

  function loadOutstandingWalletFunding(address) external pure returns (int64) {
    return 0;
  }
}
