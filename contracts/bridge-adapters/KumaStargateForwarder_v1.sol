// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILayerZeroComposer } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroComposer.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IOFT } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";
import { KumaStargateForwarderComposing } from "./KumaStargateForwarderComposing.sol";

import { LayerZeroFeeEstimation } from "./LayerZeroFeeEstimation.sol";

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol
// https://github.com/stargate-protocol/stargate-v2/blob/main/packages/stg-evm-v2/src/interfaces/IStargate.sol#L22
// We are not using any Stargate-specific extensions to the IOFT interface, so they are omitted from the
// interface declared below
interface IStargate is IOFT {

}

contract KumaStargateForwarder_v1 is ILayerZeroComposer, Ownable2Step {
  // 99.999999%
  uint64 public constant MAX_MULTIPLIER = 99999999;

  // 0.000001%
  uint64 public constant MIN_MULTIPLIER = 1;

  // Remote address of contract on XCHAIN that will be ultimate recipient of ComposeMessageType.DepositToXchain
  // messages and allowed to compose with ComposeMessageType.WithdrawFromXchain messages
  address public immutable exchangeLayerZeroAdapter;
  // Address of LayerZero endpoint contract that will call `lzCompose` when triggered by off-chain executor
  address public immutable lzEndpoint;
  // Multiplier in pips used to calculate minimum forwarded quantity after slippage
  uint64 public minimumForwardQuantityMultiplier;
  // Multiplier in pips used to calculate minimum native drop quantity included in compose compared to actual fee
  uint64 public minimumDepositNativeDropQuantityMultiplier;
  // The local OFT adapter contract used to bridge USDC to and from XCHAIN
  IOFT public immutable xchainOFT;
  // Stargate pool used to bridge tokens between the local chain and remote destination chains
  IStargate public immutable stargate;
  // Local address of ERC-20 contract that will be forwarded via OFT adapter
  IERC20 public immutable usdc;
  // LayerZero endpoint ID for XCHAIN, used to correctly route deposits
  uint32 public immutable xchainEndpointId;

  event ForwardFailed(address destinationWallet, uint256 quantity, bytes payload, bytes errorData);

  /**
   * @notice Instantiate a new `KumaStargateForwarder_v1` contract
   */
  constructor(
    address exchangeLayerZeroAdapter_,
    address lzEndpoint_,
    uint64 minimumForwardQuantityMultiplier_,
    uint64 minimumDepositNativeDropQuantityMultiplier_,
    address xchainOFT_,
    address stargate_,
    address usdc_,
    uint32 xchainEndpointId_
  ) Ownable() {
    // We cannot use Address.isContract here since exchangeLayerZeroAdapter is on a remote chain
    require(exchangeLayerZeroAdapter_ != address(0x0), "Invalid Bridge Adapter address");
    exchangeLayerZeroAdapter = exchangeLayerZeroAdapter_;

    require(Address.isContract(lzEndpoint_), "Invalid LZ Endpoint address");
    lzEndpoint = lzEndpoint_;

    minimumForwardQuantityMultiplier = minimumForwardQuantityMultiplier_;
    minimumDepositNativeDropQuantityMultiplier = minimumDepositNativeDropQuantityMultiplier_;

    require(Address.isContract(xchainOFT_), "Invalid OFT address");
    xchainOFT = IOFT(xchainOFT_);

    require(Address.isContract(stargate_), "Invalid Stargate address");
    stargate = IStargate(stargate_);

    require(Address.isContract(usdc_), "Invalid token address");
    require(IOFT(xchainOFT_).token() == usdc_, "Token address does not match OFT");
    require(IOFT(stargate_).token() == usdc_, "Token address does not match Stargate");
    usdc = IERC20(usdc_);
    // Pre-approve OFT and Stargate contracts to allow unlimited USDC transfers via either path
    usdc.approve(address(xchainOFT_), type(uint256).max);
    usdc.approve(address(stargate_), type(uint256).max);

    xchainEndpointId = xchainEndpointId_;
  }

  /**
   * @notice Allow incoming native asset to fund contract for send fees
   */
  receive() external payable {}

  /**
   * @notice Composes a LayerZero message from an OApp.
   * @param _from The address initiating the composition, typically the OApp where the lzReceive was called.
   * param _guid The unique identifier for the corresponding LayerZero src/dst tx.
   * @param _message The composed message payload in bytes. NOT necessarily the same payload passed via lzReceive.
   * param _executor The address of the executor for the composed message.
   * param _extraData Additional arbitrary data in bytes passed by the entity who executes the lzCompose.
   */
  function lzCompose(
    address _from,
    bytes32 /* _guid */,
    bytes calldata _message,
    address /* _executor */,
    bytes calldata /* _extraData */
  ) public payable override {
    require(msg.sender == lzEndpoint, "Caller must be LZ Endpoint");
    uint256 amountLD = OFTComposeMsgCodec.amountLD(_message);

    try
      KumaStargateForwarderComposing.compose(
        amountLD,
        _from,
        _message,
        exchangeLayerZeroAdapter,
        minimumDepositNativeDropQuantityMultiplier,
        minimumForwardQuantityMultiplier,
        usdc,
        stargate,
        xchainEndpointId,
        xchainOFT
      )
    {} catch (bytes memory errorData) {
      usdc.transfer(owner(), amountLD);
      emit ForwardFailed(address(0x0), amountLD, _message, errorData);
    }
  }

  /**
   * @notice Sets the tolerance for an insufficient native drop to cover gas fees when forwarding deposits to XCHAIN
   *
   * @param newMinimumDepositNativeDropQuantityMultiplier The tolerance for an insufficient native drop as a multiplier
   * in pips of the required quantity
   */
  function setMinimumDepositNativeDropQuantityMultiplier(
    uint64 newMinimumDepositNativeDropQuantityMultiplier
  ) public onlyOwner {
    require(
      minimumDepositNativeDropQuantityMultiplier >= MIN_MULTIPLIER &&
        minimumDepositNativeDropQuantityMultiplier <= MAX_MULTIPLIER,
      "Value out of bounds"
    );

    minimumDepositNativeDropQuantityMultiplier = newMinimumDepositNativeDropQuantityMultiplier;
  }

  /**
   * @notice Sets the tolerance for the minimum token quantity delivered on the remote chain after slippage
   *
   * @param newMinimumForwardQuantityMultiplier the tolerance for the minimum token quantity delivered on the remote
   * chain after slippage as a multiplier in pips of the local quantity sent
   */
  function setMinimumWithdrawQuantityMultiplier(uint64 newMinimumForwardQuantityMultiplier) public onlyOwner {
    require(
      newMinimumForwardQuantityMultiplier >= MIN_MULTIPLIER && newMinimumForwardQuantityMultiplier <= MAX_MULTIPLIER,
      "Value out of bounds"
    );

    minimumForwardQuantityMultiplier = newMinimumForwardQuantityMultiplier;
  }

  /**
   * @notice Allow Owner wallet to withdraw send fee funding
   */
  function withdrawNativeAsset(address payable destinationWallet, uint256 quantity) public onlyOwner {
    destinationWallet.transfer(quantity);
  }

  /**
   * @notice Estimate actual quantity of USDC that will be delivered on target chain after pool fees
   *
   * @dev quantity is in pips since this function is used in conjunction with the off-chain SDK and REST API
   */
  function loadEstimatedForwardedQuantityInAssetUnits(
    uint32 destinationEndpointId,
    uint64 quantity
  )
    public
    view
    returns (
      uint256 estimatedForwardedQuantityInAssetUnits,
      uint256 minimumForwardedQuantityInAssetUnits,
      uint8 poolDecimals
    )
  {
    IOFT oft = destinationEndpointId == xchainEndpointId ? xchainOFT : stargate;

    return
      LayerZeroFeeEstimation.loadEstimatedDeliveredQuantityInAssetUnits(
        destinationEndpointId,
        minimumForwardQuantityMultiplier,
        oft,
        quantity
      );
  }

  /**
   * @notice Load current gas fee for depositing to XCHAIN
   */
  function loadDepositGasFeeInAssetUnits() public view returns (uint256 gasFeeInAssetUnits) {
    uint32[] memory destinationEndpointIds = new uint32[](1);
    destinationEndpointIds[0] = xchainEndpointId;

    return
      LayerZeroFeeEstimation.loadGasFeesInAssetUnits(
        // Deposits include an enforced gas fee for composing on the XCHAIN bridge adapter
        abi.encode(xchainEndpointId, address(this)),
        destinationEndpointIds,
        minimumForwardQuantityMultiplier,
        xchainOFT
      )[0];
  }

  /**
   * @notice Load current gas fee for each target endpoint ID specified in argument array
   *
   * @param destinationEndpointIds An array of LayerZero Endpoint IDs
   */
  function loadWithdrawalGasFeesInAssetUnits(
    uint32[] calldata destinationEndpointIds
  ) public view returns (uint256[] memory gasFeesInAssetUnits) {
    return
      LayerZeroFeeEstimation.loadGasFeesInAssetUnits(
        bytes(""),
        destinationEndpointIds,
        minimumForwardQuantityMultiplier,
        stargate
      );
  }
}
