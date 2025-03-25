// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILayerZeroComposer } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroComposer.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { OptionsBuilder } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oapp/libs/OptionsBuilder.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IOFT, MessagingFee, SendParam } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";
import { ExchangeLayerZeroAdapter } from "./ExchangeLayerZeroAdapter.sol";

// https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol
// https://github.com/stargate-protocol/stargate-v2/blob/main/packages/stg-evm-v2/src/interfaces/IStargate.sol#L22
// We are not using any Stargate-specific extensions to the IOFT interface, so they are omitted from the
// interface declared below
interface IStargate is IOFT {

}

contract KumaStargateForwarder_v1 is ILayerZeroComposer, Ownable2Step {
  using OptionsBuilder for bytes;

  enum ComposeMessageType {
    DepositToXchain,
    WithdrawFromXchain
  }

  struct DepositToXchain {
    uint32 destinationEndpointId;
    address destinationWallet;
  }

  struct WithdrawFromXchain {
    uint32 destinationEndpointId;
    address destinationWallet;
  }

  // Address of LayerZero endpoint contract that will call `lzCompose` when triggered by off-chain executor
  address public immutable lzEndpoint;
  // Multiplier in pips used to calculate minimum forwarded quantity after slippage
  uint64 public minimumForwardQuantityMultiplier;
  // Multiplier in pips used to calculate minimum native drop quantity included in compose compared to actual fee
  uint64 public minimumDepositNativeDropQuantityMultiplier;
  // The local OFT adapter contract used to send tokens to the remote destination chain
  IOFT public immutable oft;
  // Stargate contract used to receive tokens from remote source chain when depositing to XCHAIN
  IStargate public immutable stargate;
  // Local address of ERC-20 contract that will be forwarded via OFT adapter
  IERC20 public immutable usdc;
  // Remote address of contract that will be ultimate recipient of ComposeMessageType.DepositToXchain messages and
  // allowed to compose with ComposeMessageType.WithdrawFromXchain messages
  address public immutable exchangeLayerZeroAdapter;

  // To convert integer pips to a fractional price shift decimal left by the pip precision of 8
  // decimals places
  uint64 public constant PIP_PRICE_MULTIPLIER = 10 ** 8;

  event ForwardFailed(address destinationWallet, uint256 quantity, bytes payload, bytes errorData);

  /**
   * @notice Instantiate a new `StargateV2OFTForwarder` contract
   */
  constructor(
    uint64 minimumForwardQuantityMultiplier_,
    uint64 minimumDepositNativeDropQuantityMultiplier_,
    address exchangeLayerZeroAdapter_,
    address lzEndpoint_,
    address oft_,
    address stargate_,
    address usdc_
  ) Ownable() {
    minimumForwardQuantityMultiplier = minimumForwardQuantityMultiplier_;
    minimumDepositNativeDropQuantityMultiplier = minimumDepositNativeDropQuantityMultiplier_;

    require(Address.isContract(exchangeLayerZeroAdapter_), "Invalid Bridge Adapter address");
    exchangeLayerZeroAdapter = exchangeLayerZeroAdapter_;

    require(Address.isContract(lzEndpoint_), "Invalid LZ Endpoint address");
    lzEndpoint = lzEndpoint_;

    require(Address.isContract(oft_), "Invalid OFT address");
    oft = IOFT(oft_);

    require(Address.isContract(stargate_), "Invalid Stargate address");
    stargate = IStargate(stargate_);

    require(Address.isContract(usdc_), "Invalid token address");
    require(IOFT(oft_).token() == usdc_, "Token address does not match OFT");
    usdc = IERC20(usdc_);

    usdc.approve(address(oft_), type(uint256).max);
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

    // Parse out composed message
    uint256 amountLD = OFTComposeMsgCodec.amountLD(_message);
    bytes memory composeMessage = OFTComposeMsgCodec.composeMsg(_message);
    // The first field in the compose message indicates the type of payload that follows it
    ComposeMessageType composeMessageType = abi.decode(composeMessage, (ComposeMessageType));

    if (composeMessageType == ComposeMessageType.DepositToXchain) {
      // Depositing to XCHAIN ExchangeLayerZeroAdapter
      require(_from == address(stargate), "OApp must be Stargate");
      uint32 sourceEndpointId = OFTComposeMsgCodec.srcEid(_message);
      _forwardDeposit(amountLD, sourceEndpointId, composeMessage);
    } else if (composeMessageType == ComposeMessageType.WithdrawFromXchain) {
      // Withdrawing from XCHAIN to EOA
      require(_from == address(oft), "OApp must be Kuma OFTAdapter");
      address composeFrom = OFTComposeMsgCodec.bytes32ToAddress(OFTComposeMsgCodec.composeFrom(_message));
      _forwardWithdrawal(amountLD, composeFrom, composeMessage);
    } else {
      // Handle poorly formed compose message
      usdc.transfer(owner(), amountLD);
      emit ForwardFailed(address(0x0), amountLD, _message, "Malformed compose message");
    }
  }

  function setMinimumDepositNativeDropQuantityMultiplier(
    uint64 newMinimumDepositNativeDropQuantityMultiplier
  ) public onlyOwner {
    minimumDepositNativeDropQuantityMultiplier = newMinimumDepositNativeDropQuantityMultiplier;
  }

  function setMinimumWithdrawQuantityMultiplier(uint64 newMinimumForwardQuantityMultiplier) public onlyOwner {
    minimumForwardQuantityMultiplier = newMinimumForwardQuantityMultiplier;
  }

  /**
   * @notice Allow Admin wallet to withdraw send fee funding
   */
  function withdrawNativeAsset(address payable destinationWallet, uint256 quantity) public onlyOwner {
    destinationWallet.transfer(quantity);
  }

  function _forwardDeposit(uint256 amountLD, uint32 sourceEndpointId, bytes memory composeMessage) private {
    (, DepositToXchain memory depositToXchain) = abi.decode(composeMessage, (ComposeMessageType, DepositToXchain));
    address destinationWallet = depositToXchain.destinationWallet;

    // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
    SendParam memory sendParam = SendParam({
      dstEid: depositToXchain.destinationEndpointId,
      to: OFTComposeMsgCodec.addressToBytes32(exchangeLayerZeroAdapter),
      amountLD: amountLD,
      minAmountLD: (amountLD * minimumForwardQuantityMultiplier) / PIP_PRICE_MULTIPLIER,
      extraOptions: bytes(""),
      composeMsg: abi.encode(sourceEndpointId, destinationWallet),
      oftCmd: bytes("") // Not used
    });
    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = oft.quoteSend(sendParam, false);
    uint256 minimumNativeDrop = (messagingFee.nativeFee * minimumDepositNativeDropQuantityMultiplier) /
      PIP_PRICE_MULTIPLIER;
    if (msg.value < minimumNativeDrop) {
      // If the depositor did not include enough native asset, transfer the token amount forwarded from the remote
      // source chain to the destination wallet address on the local chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, "Insufficient native drop");
    }

    try oft.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this))) {} catch (
      bytes memory errorData
    ) {
      // If the send fails, transfer the token amount forwarded from the remote source chain to the destination
      // wallet address on the local chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, errorData);
    }
  }

  function _forwardWithdrawal(uint256 amountLD, address composeFrom, bytes memory composeMessage) private {
    (, WithdrawFromXchain memory withdrawFromXchain) = abi.decode(
      composeMessage,
      (ComposeMessageType, WithdrawFromXchain)
    );
    address destinationWallet = withdrawFromXchain.destinationWallet;

    if (composeFrom != exchangeLayerZeroAdapter) {
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, "Invalid compose from");
    }

    // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
    SendParam memory sendParam = SendParam({
      dstEid: withdrawFromXchain.destinationEndpointId,
      to: OFTComposeMsgCodec.addressToBytes32(destinationWallet),
      amountLD: amountLD,
      minAmountLD: (amountLD * minimumForwardQuantityMultiplier) / PIP_PRICE_MULTIPLIER,
      extraOptions: bytes(""),
      composeMsg: bytes(""), // Compose not supported on withdrawal
      oftCmd: bytes("") // Not used
    });
    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = stargate.quoteSend(sendParam, false);

    try stargate.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this))) {} catch (
      bytes memory errorData
    ) {
      // If the send fails, transfer the token amount forwarded from the remote source chain to the destination
      // wallet address on the local chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, errorData);
    }
  }
}
