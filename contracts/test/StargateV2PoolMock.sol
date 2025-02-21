// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILayerZeroComposer } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroComposer.sol";
import { IOFT, MessagingFee, MessagingReceipt, OFTReceipt, SendParam } from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/interfaces/IOFT.sol";

contract StargateV2PoolMock {
  uint256 public fee;
  address public quoteTokenAddress;

  constructor(uint256 fee_, address quoteTokenAddress_) {
    fee = fee_;
    quoteTokenAddress = quoteTokenAddress_;
  }

  function token() external view returns (address) {
    return quoteTokenAddress;
  }

  function lzCompose(
    ILayerZeroComposer composer,
    address _from,
    bytes32 _guid,
    bytes calldata _message,
    address _executor,
    bytes calldata _extraData
  ) public payable {
    composer.lzCompose(_from, _guid, _message, _executor, _extraData);
  }

  function quoteSend(SendParam calldata, bool) public view returns (MessagingFee memory) {
    return MessagingFee({ nativeFee: fee, lzTokenFee:0 });
  }

  function send(
    SendParam calldata _sendParam,
    MessagingFee calldata _fee,
    address
  ) public payable returns (MessagingReceipt memory, OFTReceipt memory) {
    return (MessagingReceipt({ guid: bytes32(0x0), nonce:0, fee: _fee }), OFTReceipt({amountSentLD: _sendParam.amountLD, amountReceivedLD: _sendParam.amountLD}));
  }
}
