// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { IOFT, OFTReceipt, MessagingFee, SendParam } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

library GasFeeEstimation {
  // To convert integer pips to a fractional price shift decimal left by the pip precision of 8
  // decimals places
  uint64 public constant PIP_PRICE_MULTIPLIER = 10 ** 8;

  /**
   * @notice Estimate actual quantity of USDC that will be delivered on target chain after pool fees
   *
   * @dev quantity is in pips since this function is used in conjunction with the off-chain SDK and REST API
   */
  function loadEstimatedForwardedQuantityInAssetUnits(
    uint32 destinationEndpointId,
    uint64 minimumQuantityMultiplier,
    IOFT oft,
    uint64 quantity
  )
    internal
    view
    returns (
      uint256 estimatedWithdrawQuantityInAssetUnits,
      uint256 minimumWithdrawQuantityInAssetUnits,
      uint8 poolDecimals
    )
  {
    uint256 quantityInAssetUnits = _pipsToAssetUnits(quantity, oft.sharedDecimals());

    SendParam memory sendParam = _getSendParamForEstimation(
      bytes(""), // The compose message does not affect pool slippage
      destinationEndpointId,
      minimumQuantityMultiplier,
      quantityInAssetUnits
    );

    (, , OFTReceipt memory receipt) = oft.quoteOFT(sendParam);

    estimatedWithdrawQuantityInAssetUnits = receipt.amountReceivedLD;
    minimumWithdrawQuantityInAssetUnits = (quantityInAssetUnits * minimumQuantityMultiplier) / PIP_PRICE_MULTIPLIER;
    poolDecimals = oft.sharedDecimals();
  }

  /**
   * @notice Load current gas fee for each target endpoint ID specified in argument array
   *
   * @param destinationEndpointIds An array of LayerZero Endpoint IDs
   */
  function loadGasFeesInAssetUnits(
    bytes memory composeMsg,
    uint32[] calldata destinationEndpointIds,
    uint64 minimumQuantityMultiplier,
    IOFT oft
  ) internal view returns (uint256[] memory gasFeesInAssetUnits) {
    gasFeesInAssetUnits = new uint256[](destinationEndpointIds.length);

    for (uint256 i = 0; i < destinationEndpointIds.length; ++i) {
      SendParam memory sendParam = _getSendParamForEstimation(
        composeMsg,
        destinationEndpointIds[i],
        minimumQuantityMultiplier,
        100000000 // The actual quantity does not affect the gas fee
      );

      MessagingFee memory messagingFee = oft.quoteSend(sendParam, false);
      gasFeesInAssetUnits[i] = messagingFee.nativeFee;
    }
  }

  function _getSendParamForEstimation(
    bytes memory composeMsg,
    uint32 destinationEndpointId,
    uint64 minimumQuantityMultiplier,
    uint256 quantityInAssetUnits
  ) internal view returns (SendParam memory) {
    return
      // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
      SendParam({
        dstEid: destinationEndpointId,
        to: OFTComposeMsgCodec.addressToBytes32(address(this)), // The actual to address does not affect the result
        amountLD: quantityInAssetUnits,
        minAmountLD: (quantityInAssetUnits * minimumQuantityMultiplier) / PIP_PRICE_MULTIPLIER,
        extraOptions: bytes(""),
        composeMsg: composeMsg,
        oftCmd: bytes("") // Taxi mode
      });
  }

  /*
   * @dev Copied here from AssetUnitConversions.sol due to Solidity version mismatch
   */
  function _pipsToAssetUnits(uint64 quantity, uint8 assetDecimals) private pure returns (uint256) {
    require(assetDecimals <= 32, "Asset cannot have more than 32 decimals");

    // Exponents cannot be negative, so divide or multiply based on exponent signedness
    if (assetDecimals > 8) {
      return uint256(quantity) * (uint256(10) ** (assetDecimals - 8));
    }
    return uint256(quantity) / (uint256(10) ** (8 - assetDecimals));
  }
}
