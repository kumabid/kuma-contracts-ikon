// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { IOFT, MessagingFee, SendParam } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

library KumaStargateForwarderComposing {
  enum ComposeMessageType {
    DepositToXchain,
    WithdrawFromXchain
  }

  struct DepositToXchain {
    address destinationWallet;
  }

  struct WithdrawFromXchain {
    uint32 destinationEndpointId;
    address destinationWallet;
  }

  event ForwardFailed(address destinationWallet, uint256 quantity, bytes payload, bytes errorData);

  // To convert integer pips to a fractional price shift decimal left by the pip precision of 8
  // decimals places
  uint64 public constant PIP_PRICE_MULTIPLIER = 10 ** 8;

  function compose(
    // External arguments
    uint256 amountLD,
    address from,
    bytes calldata message,
    // State values
    address exchangeLayerZeroAdapter,
    uint64 minimumDepositNativeDropQuantityMultiplier,
    uint64 minimumForwardQuantityMultiplier,
    IERC20 usdc,
    IOFT stargate,
    uint32 xchainEndpointId,
    IOFT xchainOFT
  ) public {
    // Parse out composed message
    bytes memory composeMessage = OFTComposeMsgCodec.composeMsg(message);
    // The first field in the compose message indicates the type of payload that follows it
    ComposeMessageType composeMessageType = abi.decode(composeMessage, (ComposeMessageType));

    if (composeMessageType == ComposeMessageType.DepositToXchain) {
      // Depositing from EOA to XCHAIN Bridge Adapter
      require(from == address(stargate), "OApp must be Stargate");
      uint32 sourceEndpointId = OFTComposeMsgCodec.srcEid(message);
      _forwardDeposit(
        amountLD,
        composeMessage,
        sourceEndpointId,
        exchangeLayerZeroAdapter,
        minimumDepositNativeDropQuantityMultiplier,
        minimumForwardQuantityMultiplier,
        usdc,
        xchainEndpointId,
        xchainOFT
      );
    } else if (composeMessageType == ComposeMessageType.WithdrawFromXchain) {
      // Withdrawing from XCHAIN Bridge Adapter to EOA
      require(from == address(xchainOFT), "OApp must be Kuma OFTAdapter");
      address composeFrom = OFTComposeMsgCodec.bytes32ToAddress(OFTComposeMsgCodec.composeFrom(message));
      _forwardWithdrawal(
        amountLD,
        composeFrom,
        composeMessage,
        exchangeLayerZeroAdapter,
        minimumForwardQuantityMultiplier,
        stargate,
        usdc
      );
    } else {
      revert("Malformed compose message");
    }
  }

  function _forwardDeposit(
    // External arguments
    uint256 amountLD,
    bytes memory composeMessage,
    uint32 sourceEndpointId,
    // State values
    address exchangeLayerZeroAdapter,
    uint64 minimumDepositNativeDropQuantityMultiplier,
    uint64 minimumForwardQuantityMultiplier,
    IERC20 usdc,
    uint32 xchainEndpointId,
    IOFT xchainOFT
  ) private {
    (, DepositToXchain memory depositToXchain) = abi.decode(composeMessage, (ComposeMessageType, DepositToXchain));
    address destinationWallet = depositToXchain.destinationWallet;

    // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
    SendParam memory sendParam = SendParam({
      dstEid: xchainEndpointId,
      to: OFTComposeMsgCodec.addressToBytes32(exchangeLayerZeroAdapter),
      amountLD: amountLD,
      minAmountLD: (amountLD * minimumForwardQuantityMultiplier) / PIP_PRICE_MULTIPLIER,
      extraOptions: bytes(""),
      composeMsg: abi.encode(sourceEndpointId, destinationWallet),
      oftCmd: bytes("") // Not used
    });
    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = xchainOFT.quoteSend(sendParam, false);
    uint256 minimumNativeDrop = (messagingFee.nativeFee * minimumDepositNativeDropQuantityMultiplier) /
      PIP_PRICE_MULTIPLIER;
    if (msg.value < minimumNativeDrop) {
      // If the depositor did not include enough native asset, transfer the token amount forwarded from the remote
      // source chain to the destination wallet address on the local chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, "Insufficient native drop");

      return;
    }

    try xchainOFT.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this))) {} catch (
      bytes memory errorData
    ) {
      // If the send fails, transfer the token amount forwarded from the remote source chain to the destination
      // wallet address on the local chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, errorData);
    }
  }

  function _forwardWithdrawal(
    // External arguments
    uint256 amountLD,
    address composeFrom,
    bytes memory composeMessage,
    // State values
    address exchangeLayerZeroAdapter,
    uint64 minimumForwardQuantityMultiplier,
    IOFT stargate,
    IERC20 usdc
  ) private {
    (, WithdrawFromXchain memory withdrawFromXchain) = abi.decode(
      composeMessage,
      (ComposeMessageType, WithdrawFromXchain)
    );
    address destinationWallet = withdrawFromXchain.destinationWallet;

    if (composeFrom != exchangeLayerZeroAdapter) {
      // Only the remote Bridge Adapter on XCHAIN is allowed to compose withdrawals since this contract will pay all the
      // native fees needed to bridge them to the destination chain
      usdc.transfer(destinationWallet, amountLD);
      emit ForwardFailed(destinationWallet, amountLD, composeMessage, "Invalid compose from");

      return;
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
