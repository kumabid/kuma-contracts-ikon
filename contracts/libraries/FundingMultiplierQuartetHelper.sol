// SPDX-License-Identifier: MIT

import { Constants } from "./Constants.sol";
import { FundingMultiplierQuartet } from "./Structs.sol";
import { Math } from "./Math.sol";

pragma solidity 0.8.18;

library FundingMultiplierQuartetHelper {
  // Avoid magic numbers
  uint64 private constant _QUARTET_SIZE = 4;

  int64 private constant _EMPTY = type(int64).min;

  /**
   * @dev Adds a new funding multiplier to an array of quartets
   */
  function publishFundingMultiplier(FundingMultiplierQuartet[] storage self, int64 newFundingMultiplier) internal {
    if (self.length > 0) {
      FundingMultiplierQuartet storage fundingMultiplierQuartet = self[self.length - 1];
      if (fundingMultiplierQuartet.fundingMultiplier3 != _EMPTY) {
        // Quartet is fully populated, add new entry
        self.push(FundingMultiplierQuartet(newFundingMultiplier, _EMPTY, _EMPTY, _EMPTY));
      } else if (fundingMultiplierQuartet.fundingMultiplier1 == _EMPTY) {
        fundingMultiplierQuartet.fundingMultiplier1 = newFundingMultiplier;
      } else if (fundingMultiplierQuartet.fundingMultiplier2 == _EMPTY) {
        fundingMultiplierQuartet.fundingMultiplier2 = newFundingMultiplier;
      } else {
        fundingMultiplierQuartet.fundingMultiplier3 = newFundingMultiplier;
      }
    } else {
      // First multiplier for market, add new entry
      self.push(FundingMultiplierQuartet(newFundingMultiplier, _EMPTY, _EMPTY, _EMPTY));
    }
  }

  /**
   * @dev Given a start and end timestamp, scans an array of funding multiplier quartets and calculates the aggregate
   * funding payment to apply
   *
   * @param self The array of funding multiplier quartets
   * @param fromTimestampInMs The publish timestamp of the first funding multiplier to apply
   * @param toTimestampInMs The publish timestamp of the last funding multiplier to apply
   * @param lastFundingRatePublishTimestampInMs The publish timestamp of the latest funding multiplier in the array
   * @param positionSize The position size against which all funding multipliers are multiplied
   */
  function loadAggregatePayment(
    FundingMultiplierQuartet[] storage self,
    uint64 fromTimestampInMs,
    uint64 toTimestampInMs,
    uint64 lastFundingRatePublishTimestampInMs,
    int64 positionSize
  ) internal view returns (int64) {
    (uint256 startIndex, uint64 startOffset) = _calculateIndexAndOffsetForTimestampInMs(
      self,
      fromTimestampInMs,
      lastFundingRatePublishTimestampInMs
    );
    (uint256 endIndex, uint64 endOffset) = _calculateIndexAndOffsetForTimestampInMs(
      self,
      toTimestampInMs,
      lastFundingRatePublishTimestampInMs
    );

    if (startIndex == endIndex) {
      return _calculateAggregatePaymentForQuartet(self[startIndex], startOffset, endOffset, positionSize);
    }

    int64 aggregatePayment = _calculateAggregatePaymentForQuartet(
      self[startIndex],
      startOffset,
      _QUARTET_SIZE - 1,
      positionSize
    );
    for (uint256 i = startIndex + 1; i < endIndex; i++) {
      aggregatePayment += _calculateAggregatePaymentForQuartet(self[i], 0, _QUARTET_SIZE - 1, positionSize);
    }
    aggregatePayment += _calculateAggregatePaymentForQuartet(self[endIndex], 0, endOffset, positionSize);

    return aggregatePayment;
  }

  /**
   * @dev Calculates the aggregate funding payment for one quartet
   */
  function _calculateAggregatePaymentForQuartet(
    FundingMultiplierQuartet memory fundingMultipliers,
    uint256 startOffset,
    uint256 endOffset,
    int64 positionSize
  ) private pure returns (int64 aggregatePayment) {
    if (startOffset == 0) {
      aggregatePayment += Math.multiplyPipsByFraction(
        positionSize,
        fundingMultipliers.fundingMultiplier0,
        Math.toInt64(Constants.PIP_PRICE_MULTIPLIER)
      );
    }
    if (startOffset <= 1 && endOffset >= 1) {
      aggregatePayment += Math.multiplyPipsByFraction(
        positionSize,
        fundingMultipliers.fundingMultiplier1,
        Math.toInt64(Constants.PIP_PRICE_MULTIPLIER)
      );
    }
    if (startOffset <= 2 && endOffset >= 2) {
      aggregatePayment += Math.multiplyPipsByFraction(
        positionSize,
        fundingMultipliers.fundingMultiplier2,
        Math.toInt64(Constants.PIP_PRICE_MULTIPLIER)
      );
    }
    if (startOffset <= 3 && endOffset == 3) {
      aggregatePayment += Math.multiplyPipsByFraction(
        positionSize,
        fundingMultipliers.fundingMultiplier3,
        Math.toInt64(Constants.PIP_PRICE_MULTIPLIER)
      );
    }
  }

  function _calculateIndexAndOffsetForTimestampInMs(
    FundingMultiplierQuartet[] storage self,
    uint64 targetTimestampInMs,
    uint64 lastTimestampInMs
  ) private view returns (uint256 index, uint64 offset) {
    // The last element may not be fully populated, but previous elements alway are
    uint64 totalNumberOfMultipliers = _calculateNumberOfMultipliersInQuartet(self[self.length - 1]) +
      // We can safely downcast since 2^63 multipliers would take several quadrillion years to exceed
      (uint64(self.length - 1) * _QUARTET_SIZE);
    // Calculate the timestamp of the very first multiplier
    uint64 firstTimestampInMs = lastTimestampInMs - ((totalNumberOfMultipliers - 1) * Constants.FUNDING_PERIOD_IN_MS);

    // Calculate the number of multipliers from the first published timestamp to the target timestamp, both inclusive
    uint64 numberOfMultipliersFromFirstToTargetTimestamp = 1 +
      ((targetTimestampInMs - firstTimestampInMs) / Constants.FUNDING_PERIOD_IN_MS);

    // Calculate index and offset of target timestamp
    index = Math.divideRoundUp(numberOfMultipliersFromFirstToTargetTimestamp, _QUARTET_SIZE) - 1;
    offset = numberOfMultipliersFromFirstToTargetTimestamp % _QUARTET_SIZE == 0
      ? 3
      : (numberOfMultipliersFromFirstToTargetTimestamp % _QUARTET_SIZE) - 1;
  }

  /**
   * @dev Calculates the number of multipliers packed in one quartet
   */
  function _calculateNumberOfMultipliersInQuartet(
    FundingMultiplierQuartet memory fundingMultipliers
  ) private pure returns (uint64 multiplierCount) {
    if (fundingMultipliers.fundingMultiplier3 != _EMPTY) {
      return 4;
    }
    if (fundingMultipliers.fundingMultiplier2 != _EMPTY) {
      return 3;
    }
    if (fundingMultipliers.fundingMultiplier1 != _EMPTY) {
      return 2;
    }

    // A quartet always includes at least one multiplier
    return 1;
  }
}
