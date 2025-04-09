// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILayerZeroComposer } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroComposer.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/libs/OFTComposeMsgCodec.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IOFT, MessagingFee, SendParam } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

import { KumaStargateForwarderComposing } from "./KumaStargateForwarderComposing.sol";
import { LayerZeroFeeEstimation } from "./LayerZeroFeeEstimation.sol";

interface IExchange {
  function deposit(uint256 quantityInAssetUnits, address destinationWallet) external;
}

contract ExchangeLayerZeroAdapter_v2 is ILayerZeroComposer, Ownable2Step {
  // LayerZero endpoint ID for Berachain
  uint32 public immutable berachainEndpointId;
  // Address of Exchange contract
  IExchange public immutable exchange;
  // Must be true or `lzCompose` will revert
  bool public isDepositEnabled;
  // Must be true or `withdrawQuoteAsset` will revert
  bool public isWithdrawEnabled;
  // Address of LayerZero endpoint contract that will call `lzCompose` when triggered by off-chain executor
  address public immutable lzEndpoint;
  // Multiplier in pips used to calculate minimum withdraw quantity after slippage
  uint64 public minimumWithdrawQuantityMultiplier;
  // Address of ERC-20 contract used as collateral and quote for all markets
  IERC20 public immutable quoteAsset;
  // Address of the Stargate Forwarder contract on Berachain
  address public stargateForwarder;
  // Local OFT contract used to send tokens by `withdrawQuoteAsset`
  IOFT public immutable oft;

  // To convert integer pips to a fractional price shift decimal left by the pip precision of 8
  // decimals places
  uint64 public constant PIP_PRICE_MULTIPLIER = 10 ** 8;

  event LzComposeSucceeded(uint32 sourceEndpointId, address composeFrom, address destinationWallet, uint256 quantity);

  event LzComposeFailed(address destinationWallet, uint256 quantity, bytes errorData);

  event WithdrawQuoteAssetFailed(address destinationWallet, uint256 quantity, bytes payload, bytes errorData);

  modifier onlyExchange() {
    require(msg.sender == address(exchange), "Caller must be Exchange contract");
    _;
  }

  /**
   * @notice Instantiate a new `ExchangeLayerZeroAdapter` contract
   */
  constructor(
    uint32 berachainEndpointId_,
    address exchange_,
    address lzEndpoint_,
    uint64 minimumWithdrawQuantityMultiplier_,
    address oft_,
    address quoteAsset_
  ) Ownable() {
    berachainEndpointId = berachainEndpointId_;

    require(Address.isContract(exchange_), "Invalid Exchange address");
    exchange = IExchange(exchange_);

    require(Address.isContract(lzEndpoint_), "Invalid LZ Endpoint address");
    lzEndpoint = lzEndpoint_;

    minimumWithdrawQuantityMultiplier = minimumWithdrawQuantityMultiplier_;

    require(Address.isContract(oft_), "Invalid OFT address");
    oft = IOFT(oft_);

    require(Address.isContract(quoteAsset_), "Invalid quote asset address");
    require(oft.token() == quoteAsset_, "Quote asset address does not match OFT");
    quoteAsset = IERC20(quoteAsset_);

    IERC20(quoteAsset).approve(exchange_, type(uint256).max);
    IERC20(quoteAsset).approve(oft_, type(uint256).max);
  }

  /**
   * @notice Allow incoming native asset to fund contract for gas fees, as well as incoming gas fee refunds
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
    require(_from == address(oft), "Invalid OApp");

    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/libs/OFTComposeMsgCodec.sol#L52
    uint256 amountLD = OFTComposeMsgCodec.amountLD(_message);

    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/libs/OFTComposeMsgCodec.sol#L61
    (uint32 sourceEndpointId, address destinationWallet) = abi.decode(
      OFTComposeMsgCodec.composeMsg(_message),
      (uint32, address)
    );

    // If the provided destination wallet is invalid, then it is unclear where the tokens should
    // go. Rather than have them stuck in this contract we transfer the tokens to the admin
    // wallet so they can be appropriately disbursed manually
    if (destinationWallet == address(0x0)) {
      IERC20(quoteAsset).transfer(owner(), amountLD);
      emit LzComposeFailed(destinationWallet, amountLD, "Invalid destination wallet");
      // Incoming bridge deposits consists of 2 separate transactions. The first calls lzReceive and
      // mints tokens to the bridge contract. The second calls lzCompose which deposits the tokens
      // into the Exchange. If lzCompose fails without transferring out the tokens, then the tokens
      // could end up stuck in this contract as there is no way to directly transfer them out. To
      // avoid this, if the deposit cannot be completed successfully for any reason then we transfer
      // the tokens directly to the destination wallet so they can retry later
    } else if (!isDepositEnabled) {
      IERC20(quoteAsset).transfer(destinationWallet, amountLD);
      emit LzComposeFailed(destinationWallet, amountLD, "Deposits disabled");
    } else {
      try exchange.deposit(amountLD, destinationWallet) {
        emit LzComposeSucceeded(
          sourceEndpointId,
          OFTComposeMsgCodec.bytes32ToAddress(OFTComposeMsgCodec.composeFrom(_message)),
          destinationWallet,
          amountLD
        );
      } catch (bytes memory errorData) {
        IERC20(quoteAsset).transfer(destinationWallet, amountLD);
        emit LzComposeFailed(destinationWallet, amountLD, errorData);
      }
    }
  }

  /**
   * @notice Set the address of the Stargate Forwarder contract. Can only be called once
   */
  function setStargateForwarder(address stargateForwarder_) public onlyOwner {
    require(stargateForwarder == address(0x0), "Stargate Forwarder can only be set once");
    // We cannot check that the address is a contract since it resides on a remote chain

    stargateForwarder = stargateForwarder_;
  }

  /**
   * @notice Allow Admin wallet to withdraw gas fee funding
   */
  function withdrawNativeAsset(address payable destinationContractOrWallet, uint256 quantity) public onlyOwner {
    (bool success, ) = destinationContractOrWallet.call{ value: quantity }("");
    require(success, "Native asset transfer failed");
  }

  /**
   * @dev quantity is in asset units
   */
  function withdrawQuoteAsset(address destinationWallet, uint256 quantity, bytes memory payload) public onlyExchange {
    require(isWithdrawEnabled, "Withdraw disabled");

    SendParam memory sendParam = _getSendParamForWithdraw(destinationWallet, quantity, payload);

    // https://github.com/LayerZero-Labs/LayerZero-v2/blob/1fde89479fdc68b1a54cda7f19efa84483fcacc4/oapp/contracts/oft/interfaces/IOFT.sol#L127C14-L127C23
    MessagingFee memory messagingFee = oft.quoteSend(sendParam, false);

    try oft.send{ value: messagingFee.nativeFee }(sendParam, messagingFee, payable(address(this))) {} catch (
      bytes memory errorData
    ) {
      // If the swap fails, redeposit funds into Exchange so wallet can retry
      exchange.deposit(quantity, destinationWallet);
      emit WithdrawQuoteAssetFailed(destinationWallet, quantity, payload, errorData);
    }
  }

  /**
   * @notice Disable deposits
   */
  function setDepositEnabled(bool isEnabled) public onlyOwner {
    isDepositEnabled = isEnabled;
  }

  /**
   * @notice Sets the tolerance for the minimum token quantity delivered on the remote chain after slippage
   *
   * @param newMinimumWithdrawQuantityMultiplier the tolerance for the minimum token quantity delivered on the
   * remote chain after slippage as a multiplier in pips of the local quantity sent
   */
  function setMinimumWithdrawQuantityMultiplier(uint64 newMinimumWithdrawQuantityMultiplier) public onlyOwner {
    minimumWithdrawQuantityMultiplier = newMinimumWithdrawQuantityMultiplier;
  }

  /**
   * @notice Disable withdrawals
   */
  function setWithdrawEnabled(bool isEnabled) public onlyOwner {
    isWithdrawEnabled = isEnabled;
  }

  /**
   * @notice Estimate actual quantity of quote tokens that will be delivered on target chain after pool fees
   *
   * @dev quantity is in pips since this function is used in conjunction with the off-chain SDK and REST API
   */
  function estimateWithdrawQuantityInAssetUnits(
    uint32 destinationEndpointId,
    uint64 quantity
  )
    public
    view
    returns (
      uint256 estimatedWithdrawQuantityInAssetUnits,
      uint256 minimumWithdrawQuantityInAssetUnits,
      uint8 poolDecimals
    )
  {
    return
      LayerZeroFeeEstimation.loadEstimatedDeliveredQuantityInAssetUnits(
        destinationEndpointId,
        minimumWithdrawQuantityMultiplier,
        oft,
        quantity
      );
  }

  /**
   * @notice Load current gas fees for withdrawing to Berachain
   */
  function loadBerachainWithdrawalGasFeesInAssetUnits()
    public
    view
    returns (uint256 gasFeeWithoutForwardInAssetUnits, uint256 gasFeeWithForwardInAssetUnits)
  {
    uint32[] memory destinationEndpointIds = new uint32[](1);
    destinationEndpointIds[0] = berachainEndpointId;

    gasFeeWithoutForwardInAssetUnits = LayerZeroFeeEstimation.loadGasFeesInAssetUnits(
      bytes("0x"), // Compose not supported for withdrawals
      destinationEndpointIds,
      minimumWithdrawQuantityMultiplier,
      oft
    )[0];
    gasFeeWithForwardInAssetUnits = LayerZeroFeeEstimation.loadGasFeesInAssetUnits(
      abi.encode(
        KumaStargateForwarderComposing.ComposeMessageType.WithdrawFromXchain,
        // The encoded destination endpoint and wallet values do not matter for estimation purposes
        KumaStargateForwarderComposing.WithdrawFromXchain(berachainEndpointId, address(this))
      ),
      destinationEndpointIds,
      minimumWithdrawQuantityMultiplier,
      oft
    )[0];
  }

  function _getSendParamForWithdraw(
    address destinationWallet,
    uint256 quantityInAssetUnits,
    bytes memory payload
  ) private view returns (SendParam memory) {
    uint32 destinationEndpointId = abi.decode(payload, (uint32));

    // Withdrawing to wallet on Berachain, no compose
    if (destinationEndpointId == berachainEndpointId) {
      return
        // https://docs.layerzero.network/v2/developers/evm/oft/quickstart#estimating-gas-fees
        SendParam({
          dstEid: berachainEndpointId,
          to: OFTComposeMsgCodec.addressToBytes32(destinationWallet),
          amountLD: quantityInAssetUnits,
          minAmountLD: (quantityInAssetUnits * minimumWithdrawQuantityMultiplier) / PIP_PRICE_MULTIPLIER,
          extraOptions: bytes(""), // No extra native asset needed
          composeMsg: bytes(""), // Compose not supported for withdrawals
          oftCmd: bytes("") // Taxi mode
        });
    }

    // Withdrawing to Stargate Forwarder contract on Berachain
    return
      SendParam({
        dstEid: berachainEndpointId,
        to: OFTComposeMsgCodec.addressToBytes32(stargateForwarder),
        amountLD: quantityInAssetUnits,
        minAmountLD: (quantityInAssetUnits * minimumWithdrawQuantityMultiplier) / PIP_PRICE_MULTIPLIER,
        extraOptions: bytes(""), // No extra native asset needed
        composeMsg: abi.encode(
          KumaStargateForwarderComposing.ComposeMessageType.WithdrawFromXchain,
          KumaStargateForwarderComposing.WithdrawFromXchain(destinationEndpointId, destinationWallet)
        ),
        oftCmd: bytes("") // Taxi mode
      });
  }
}
