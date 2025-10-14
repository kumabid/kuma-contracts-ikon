<!-- markdownlint-disable MD033 -->
# <img src="assets/kuma-logo.png" alt="Kuma" height="37px" valign="top"> Ikon Smart Contracts

![Tests](./assets/tests.svg)
![Lines](./assets/coverage-lines.svg)
![Branches](./assets/coverage-branches.svg)
![Functions](./assets/coverage-functions.svg)
![Statements](./assets/coverage-statements.svg)

## Overview

This repo collects source code, tests, and documentation for the primary [Kuma](https://kuma.bid) Solidity contracts.

## Usage

This repo is set up as a [Hardhat](https://hardhat.org/) project, with library and test code written in Typescript. To build:

```console
nvm use
yarn && yarn build
```

To run the test suite and generate a coverage report:

```console
yarn test:coverage
```

## Background

The Kuma Ikon release brings high-performance, leveraged trading backed by smart contract fund custody to the [Berachain](https://www.berachain.com/) ecosystem.

## Contract Structure

The Ikon on-chain infrastructure includes three main contracts and a host of supporting libraries.

- Custodian: custodies user funds with minimal additional logic.
- Governance: implements [upgrade logic](#upgradability) while enforcing [governance constraints](#controls-and-governance).
- Exchange: implements the majority of exchange functionality, including storage for wallet balance tracking.

Bytecode size limits require splitting much of Exchange’s logic into external library delegatecalls. ClosureDeleveraging, Depositing, Funding, IndexPriceMargin, MarketAdmin, OraclePriceMargin, PositionBelowMinimumLiquidation, PositionInDeactivatedMarketLiquidation, Trading, Transferring, WalletExitAcquisitionDeleveraging, WalletExitLiquidation, WalletInMaintenanceAcquisitionDeleveraging, WalletInMaintenanceLiquidation, and Withdrawing are structured as external libraries supporting Exchange functionality and interacting with Exchange storage. Additionally, stack size limits require many function parameters to be packaged as structs.

An extensible set of [bridge protocol adapter contracts](#cross-chain-bridge-protocol-support) implements support for cross-chain [deposits](#deposit) and [withdrawals](#withdraw).

## Perpetuals

Ikon implements a fully cross-margined perpetual futures trading product collateralized by USDC. It includes the standard operational components of a centralized perpetuals exchange, such as leveraged trading, index pricing, funding payments, liquidation, and automatic deleveraging, while maintaining fund custody in independently-audited smart contracts. It also includes [unique anti-censorship designs](#wallet-exits) to ensure access to user funds in case the off-chain components of the exchange are compromised or otherwise unavailable.

## Trading Lifecycle

Ikon supports trading a wide range of synthetic assets via perpetual futures contracts. Unlike spot exchanges, only USDC may be deposited and withdrawn; all other asset positions are collateralized by USDC. The trading lifecycle spans three steps.

### Deposit

Users must deposit funds into the Ikon contracts before they are available for trading on Kuma. [Only USDC may be deposited](#quote-asset-and-quote-token), and depositing requires an `approve` call on the token contract before calling `deposit` on the Exchange contract.

- The `deposit` function is exposed by the Exchange contract, but funds are ultimately held in the Custodian contract. As part of the deposit process, tokens are transferred from the funding wallet to the Custodian contract while the Exchange contract’s storage tracks wallet asset balances. Separate exchange logic and fund custody supports Ikon’s [upgrade design](#upgradability).
- Deposits are credited to a wallet’s Exchange balance tracking via a two-step process. On the initial `deposit` call, funds are credited to temporary storage in `pendingDepositQuantityByWallet`; once the off-chain systems process the deposit, the quantity is moved to the wallet’s quote balance in `_balanceTracking` by a whitelisted dispatcher wallet. This two-step process avoids race conditions by ensuring that margin calculations and other contract checks are synchronized between off- and on-chain systems.
- In order to support [seamless cross-chain deposits](#cross-chain-bridge-protocol-support), deposits may be credited to any destination wallet address. Leaving `destinationWallet` as 0x0 credits funds to the calling wallet’s address. **Funds deposited to a destination wallet address to which the user does not have access are permanently lost.**
- Deposits from [exited wallets](#wallet-exits) are rejected.

### Trade

Ikon includes support for order book trades only. All order management and trade matching happens off-chain while trades are ultimately settled on-chain. A trade is considered settled when the Exchange contract’s wallet asset balances reflect the new values agreed to in the trade. Exchange’s `executeTrade` function is responsible for settling trades.

- Unlike deposits, trade settlement can only be initiated via a whitelisted dispatcher wallet controlled by Kuma. Users do not settle trades directly; only Kuma can submit trades for settlement. Because Kuma alone controls dispatch, Kuma’s off-chain components can guarantee the eventual on-chain trade settlement order and thus allow users to trade in real-time without waiting for dispatch or mining.
- The primary responsibility of the trade functions is order and trade validation. In the case that Kuma off-chain infrastructure is compromised, the validations ensure that funds can only move in accordance with orders signed by the depositing wallet. Ikon additionally supports orders signed by a [delegated key](#delegated-keys) that is authorized by the depositing wallet.
- Like all actions that change wallet balances, trade settlement applies outstanding [funding payments](#funding-payments) to the participating wallets.
- As traders may take on leverage, trade settlement enforces [margin requirements](#margin) on any resulting positions. Wallets must meet the initial margin requirement following any trade that increases the absolute quantity of a position and must meet the maintenance margin requirement following any trade that decreases the absolute quantity of a position.
- Due to business requirements, order quantity and price are specified as strings in [pip precision](#precision-and-pips), hence the need for order signature validation to convert the provided values to strings.
- Ikon supports partial fills on orders, which requires additional bookkeeping to prevent overfills and replays.
- [Fees](#fees) are assessed as part of trade settlement. The off-chain trading engine computes fees, but the contract logic is responsible for enforcing that fees are within [previously defined limits](#controls-and-governance). Because only an Kuma-controlled dispatcher wallet can make the settlement calls, Kuma is the immediate gas payer for trade settlement. Kuma passes along the estimated gas costs to users by including them in the trade fees.

### Withdraw

Similar to trade settlement, withdrawals are initiated by users via Kuma’s off-chain components, but calls to the Exchange contract’s `withdraw` function are restricted to a whitelisted dispatcher wallet. `withdraw` calls are limited to a dispatcher wallet in order to guarantee the balance update sequence and thus support trading ahead of settlement. There is also a [wallet exit](#wallet-exits) mechanism to prevent withdrawal censorship by Kuma. [Only USDC may be withdrawn.](#quote-asset-and-quote-token)

- Users may withdraw USDC collateral up to the [initial margin requirements](#margin) of the wallet without first liquidating positions.
- Ikon supports seamless cross-chain withdrawals via [bridge adapter contracts](#cross-chain-bridge-protocol-support).
- Kuma collects fees on withdrawals in order to cover the gas costs of the `withdraw` function call. Because only an Kuma-controlled dispatcher wallet can make the `withdraw` call, Kuma is the immediate gas payer for user withdrawals. Kuma passes along the estimated gas costs to users by collecting a fee out of the withdrawn amount. Withdrawal gas fees are limited to a `maximumGasFee` parameter signed by the wallet, or the withdrawal request is rejected.
- Like all actions that change wallet balances, withdrawals apply outstanding funding payments to the withdrawing wallet.
- Despite the `withdraw` function being part of the Exchange contract, funds are returned to the user’s wallet from the Custodian contract.

### Transfer

In addition to withdrawals, Ikon includes the ability for wallets to transfer quote funds directly to other wallets within the Exchange. Transfers are subject to the same constraints as withdrawals, including margin requirements and gas fees.

## Liquidation

In some situations, Ikon proactively liquidates wallets or balances to ensure the solvency of the system. Only an Kuma-controlled dispatcher wallet is authorized to perform liquidations, and liquidation actions validate the conditions under which they may proceed. Two special wallets, the insurance fund and the exit fund, acquire balances during most liquidations.

- [Index prices](#index-pricing) rather than order book prices determine margin requirements and thus liquidation conditions.
- Like all actions that change wallet balances, liquidations apply outstanding [funding payments](#funding-payments) to the participating wallet.
- For liquidation, the Ikon contract codebase refers to the wallet that is having its positions forcibly closed as the liquidating wallet and the wallet assuming the positions as the counterparty wallet.

### Position Below Minimum

Condition: Liquidation of a single position that is smaller than the minimum position size of the market. Positions may fall below the market minimum as a result of partial fills during trading.

- The insurance fund acquires the position at the current index price with a small additional price tolerance. The price tolerance allows Ikon to account for slippage and processing fees when liquidating positions. See [controls and governance](#controls-and-governance) for limits. Price validation is skipped for very small positions where rounding issues may preclude expected pricing.

### Position In Deactivated Market

Condition: Liquidation of a single position in a deactivated market. Ikon liquidates all remaining open positions after a market is deactivated.

- Neither the insurance fund nor the exit fund acquire the position. Total long and short position quantities are always equal within a market, allowing all positions to be closed without explicit counterparties.
- All positions are closed at the market index price at the time of deactivation.

### Wallet In Maintenance

Condition: Liquidation of a wallet that does not meet its maintenance margin requirements during normal system operation.

- All positions of the wallet are acquired by the insurance fund at the wallet’s bankruptcy price. The bankruptcy value of each position is computed such that the overall wallet value is zero after liquidation.
- To account for [fixed precision](#precision-and-pips) rounding issues, any remaining dust quote amount is transferred to or from the insurance fund as a last step.
- The insurance fund must meet its own margin requirements and position size maximums after acquiring the wallet’s positions.

### Wallet In Maintenance During System Recovery

Condition: Liquidation of a wallet that does not meet its maintenance margin requirements during [offline system recovery](#offline-operation). Wallet In Maintenance During System Recovery liquidation differs from normal Wallet In Maintenance liquidation:

- Positions are acquired by the exit fund rather than the insurance fund.
- The exit fund has no margin requirements, eliminating the need for margin validation.

### Wallet Exited

Conditions: Liquidation of an [exited wallet](#wallet-exits). Ikon’s off-chain components proactively liquidate wallets on exit.

- Wallet may or may not meet its maintenance margin requirement.
- Positions are liquidated to the insurance fund at the exit price or bankruptcy price. The exit price of a position is the worse of the entry price or current index price, and the exit account value is the total value of a wallet using exit pricing. Exit pricing is used in the liquidation of positions if the exit account value of a wallet is positive, otherwise bankruptcy pricing is used.
- To account for [fixed precision](#precision-and-pips) rounding issues, any remaining dust quote amount is transferred to or from the insurance fund as a last step when using bankruptcy pricing.
- The insurance fund must meet its own margin requirements and position size maximums after acquiring the wallet’s positions.

## Automatic Deleveraging

In some situations, Ikon closes open positions directly against select counterparty positions in a process called automatic deleveraging (ADL). ADL provides a backstop of system solvency when liquidation is not an option. Only an Kuma-controlled dispatcher wallet is authorized to perform ADL, and ADL actions validate the conditions under which they may proceed.

- ADL actions fall into two categories: acquisition and closure. Acquisition ADL applies when the insurance fund is unable to acquire a position due to its [margin requirements](#margin) or position size maximums. Closure ADL applies when order book liquidity is insufficient or unavailable to close a position acquired by the insurance or exit funds.
- Unlike liquidation, ADL actions apply to a single position and counterparty for each settlement. One position may require several ADL settlements to completely close as the selected counterparty positions may be smaller than the target position.
- [Index prices](#index-pricing) rather than order book prices determine margin requirements and thus ADL conditions.
- ADL actions validate that the counterparty wallet meets its margin requirements after the settlement.
- Like all actions that change wallet balances, liquidations apply outstanding [funding payments](#funding-payments) to the participating wallet.
- For ADL, the Ikon contract codebase refers to a wallet that is having its position closed as the liquidating wallet and the wallet of the selected counterparty position as the counterparty wallet.

### In Maintenance Acquisition (Wallet In Maintenance)

Condition: Reduction of a single position of a wallet that does not meet its maintenance margin requirements against a counterparty position during normal system operation.

- Validates that ADL happens at the bankruptcy price of the liquidating wallet’s position up to the quantity available from the counterparty position.

### Insurance Fund Closure

Condition: Reduction of a single position held by the insurance fund against a counterparty position at the entry price of the insurance fund.

- Applies when there is insufficient liquidity on the order book for the insurance fund to close the position via normal [trade](#trade) settlement.

### Exit Acquisition (Wallet Exited)

Condition: Reduction of a single position of an exited wallet, regardless of maintenance margin requirements, against a counterparty position during normal system operation.

- Positions are deleveraged at the exit price or bankruptcy price. The exit price of a position is the worse of the entry price or current index price, and the exit account value is the total value of a wallet using exit pricing. During each Exit Acquisition settlement, contract logic checks whether the exit account value of the wallet is positive. If so, the deleverage proceeds using the exit price. If the exit account value is not positive, however, contract logic selects the bankruptcy price, persists the decision, and uses the bankruptcy price for the current and all subsequent deleverage settlements for the wallet. Because closing all positions of a wallet via Exit Acquisition ADL may require several settlements, the exit account value of a wallet may change between settlements.
- Validates ADL happens at either the exit or bankruptcy price of the liquidating wallet’s position up to the quantity available from the counterparty position.

### Exit Fund Closure

Condition: Reduction of a single position held by the exit fund against a counterparty position.

- Validates that ADL happens at the index price if the exit fund account value is positive or at the exit fund's bankruptcy price if the exit fund account value is negative.
- Applies when closing all open exit fund positions during [offline system recovery](#offline-operation).

## Margin

The Kuma Ikon release offers leveraged trading, making margin a key concept for both users and exchange operations. Ikon implements a cross-margined model, where all open positions count towards an aggregate total account value and margin requirements. Margin requirements are defined on a per-market basis using two primary parameters:

- `initialMarginFraction`: Margin requirement necessary to open a position, withdraw, or transfer funds.
- `maintenanceMarginFraction`: Margin requirement necessary to prevent [liquidation](#liquidation). This is almost always set lower than `initialMarginFraction` to allow for price movement before liquidation.

For example, the BTC-USD market could have an `initialMarginFraction` of 0.1 implying a maximum leverage of 10x. If the `maintenanceMarginFraction` is 0.05, wallets with an open BTC-USD position exceeding 20x leverage due to price movement may be liquidated.

Initial margin requirements scale based on the absolute size of a position. Several market-configurable parameters define initial margin scaling.

- `baselinePositionSize`: Maximum position size available under the `initialMarginFraction`.
- `incrementalPositionSize`, `incrementalInitialMarginFraction`: If a position exceeds `baselinePositionSize`, each step of `incrementalPositionSize` increases the `initialMarginFraction` by `incrementalInitialMarginFraction`.

While margin parameters are defined on a market basis, they may be overridden for specific wallets. Specifying non-standard margin terms for a wallet is a restricted admin action and is subject to a governance delay for safety. See [controls and governance](#controls-and-governance) for details.

All margin calculations are performed on index prices rather than order book prices, providing greater stability and fidelity to underlying asset values.

## Index Pricing

Index prices are an important input to Ikon operations. Index prices represent the fair value of the underlying assets of perpetual futures markets, such as BTC and ETH. Index prices are collected from a variety of reliable price sources, normalized to exclude outliers and spurious data, and updated with high frequency and low latency. 

Ikon uses index prices rather than order book prices for all [margin calculations](#margin). As a result, index pricing determines whether a wallet has sufficient funds to [open positions](#trade), when wallets are [liquidated](#liquidation) or [deleveraged](#automatic-deleveraging), and whether to authorize [withdrawals](#withdraw) and [transfers](#transfer). Index prices are also an important input to [funding payments](#funding-payments). The use of index prices reduces the impact of short term order book price movement on exchange operations.

Index prices are frequently updated in Ikon’s off-chain infrastructure and lazily published on chain via Exchange’s `publishIndexPrices` by the dispatcher wallet. Specifically, on-chain index prices are only updated immediately prior to another dependent operation. For example, if the BTC-USD on-chain index price is out of date, Ikon’s off-chain infrastructure first publishes the latest index price for BTC before submitting a new trade for settlement. Lazy on-chain price updates minimize transaction volume and gas costs.


- Ikon implements a modular index price validation system supporting an extensible range of pricing data sources. At launch, Ikon supports [Pyth Network](https://pyth.network/), [Stork](https://www.stork.network/), and an Kuma-operated first party index price data service.
- Modular index price adapter contracts may be added, upgraded, or removed independently of [Exchange upgrades](#upgradability), subject to a governance delay for safety. See [controls and governance](#controls-and-governance) for details.
- First party index prices are collected by secure off-chain systems from a range of price sources. They are signed at the point of collection with signatures that are verified on chain.
- In addition to verifying signatures, contract logic also verifies that index price timestamps are greater than the last committed index price, and also that timestamps are not more than one day in the future.
- Due to lazy index price updates, on-chain accessors that rely on index pricing, such as `loadTotalAccountValueFromIndexPrices` and other `*FromIndexPrices` functions, may return out-of-date values. 

## Oracle Pricing

Some operations, such as [exited wallet](#wallet-exits) withdrawals, require up-to-date asset prices without access to Ikon’s real time [index prices](#index-pricing). For these use cases, Ikon implements a modular oracle price system similar to its modular [index price](#index-pricing) system.

- The active oracle price adapter may be updated independently of [Exchange upgrades](#upgradability), subject to a governance delay for safety. See [controls and governance](#controls-and-governance) for details.
- Exchange includes on-chain accessors that use oracle pricing instead of index pricing, such as `loadTotalAccountValueFromOraclePrices` and other `*FromOraclePrices` functions, for convenient on-chain analysis. **Due to the difference in methodology between oracle price collection and index price collection, these functions may return different values than the index-price equivalents, even when index prices are up to date.**


## Funding Payments

Funding payments are a common mechanism for incentivizing the convergence of order book and [index prices](#index-pricing) over time. Ikon implements a standard off-chain funding payments system but takes a novel approach to its on-chain logic. Similar to most funding payment systems, Ikon generates a payment for every open position in the system every eight hours. As a result, a naive contract design could generate an impractically large number of funding payment transactions. Instead, the dispatcher wallet makes a single call to Exchange’s `publishFundingMultiplier` every eight hours for each active market. Funding rates are then lazily applied to wallet balances on the next action, such as a trade or withdrawal. 

- Funding rate multipliers are stored in a tightly-packed data structure to minimize storage and gas. Specifically, the system computes `funding rate * index price` so that the stored values may be multiplied directly by open position balances in the lazy application logic.
- Funding payments are aligned to UTC 00:00, 08:00, and 16:00 every day. While not expected, any gaps are automatically filled with 0 values so as to not impact lazy application. Each market starts funding payments at UTC 00:00 on the day the market is added to the contract, with any prior periods of the day backfilled with 0.
- All actions that update wallet balances update funding payments. Wallet balances track the last funding payment application timestamp to facilitate lazy updates. Funding payments apply to all open positions for a wallet but only generate a single quote position update on application. 
- Due to transaction gas limits, it is possible for an inactive wallet with open positions to fall outside of the lazy application window. As such, Exchange includes `applyOutstandingWalletFundingForMarket` for the off-chain systems to proactively trigger lazy updates if necessary.
- Exchange includes `loadOutstandingWalletFunding`, an accessor for a wallet’s outstanding funding payments awaiting lazy application. Other accessors, such as `loadTotalAccountValue`, `loadTotalInitialMarginRequirement`, and `loadTotalMaintenanceMarginRequirement` automatically include outstanding funding payments but do not apply the updates.

## Wallet Exits

Ikon includes a wallet exit mechanism, allowing users to withdraw funds in the case that Kuma is offline or maliciously censoring withdrawals. Calling `exitWallet` initiates the exit process, which prevents the wallet from subsequent deposits, trades, or normal withdrawals. Wallet exits are a two-step process as defined in [controls](#controls-and-governance).

In Ikon, wallet exit withdrawals via Exchange’s `withdrawExit` close any open positions and return the remaining USDC quote balance, including any pending deposits, to the wallet. In order to support offline operation, exit withdrawals must execute deterministically in contract logic without the user supplying counterparty positions for closure. To achieve this behavior, all positions liquidated in an exit withdrawal are acquired by a designated exit fund wallet. The exit fund does not have any margin requirements, which maximizes the range of positions it can acquire, and is excluded from a number of exchange activities. See [offline operation](#offline-operation) for details.

**Importantly, in order to ensure the solvency of the system, the exit value of positions differs from their order book or index price values.** During exit withdrawals, positions are acquired by the exit fund at the exit price or bankruptcy price. The exit price of a position is the worse of the entry price or current index price, and the exit account value is the total value of a wallet using exit pricing. Exit pricing is used in the acquisition of positions if the exit account value of a wallet is positive, otherwise bankruptcy pricing is used. As a result, wallets with a negative exit account value due to unrealized losses receive zero USDC during a `withdrawExit`. Wallet positions are still closed in this scenario. Exchange includes `loadQuoteQuantityAvailableForExitWithdrawal` to query the exit value of a wallet before exiting or calling `withdrawExit`.

**Wallets that exit during normal online exchange operation are proactively liquidated at the exit price or bankruptcy price by Kuma’s off-chain systems.** In this case, the exited wallet’s positions are [acquired by the insurance fund](#wallet-exited) or [deleveraged](#exit-acquisition-wallet-exited), but the result to the wallet holder is the same. It is still necessary to separately call `withdrawExit` to withdraw the remaining USDC balance of the exited wallet.

## Delegated Keys

Ikon introduces a new method of order authorization with delegated keys. When using delegated keys, the owner of a custody wallet authorizes a different Ethereum key pair to place and cancel orders on its behalf. Delegated keys convey a number of UX advantages and increase the security of some use cases. Ikon continues to support the direct signing of orders by custody wallets.

- In order to authorize a new delegated key, a custody wallet signs a delegated key authorization message, which includes the current signature hash version, a human-readable text string, the delegated key’s public key, and a [nonce](#nonces-and-invalidation). Together with the signature, these comprise the delegated key authorization.
- Delegated key authorizations are included with orders submitted for trade settlement when used. In this case, the order hash is signed by the delegated key’s private key.
- Delegated keys are valid for a fixed period of time from their creation as determined by the authorization nonce. `delegateKeyExpirationPeriodInMs` is a tunable parameter as covered in [controls and governance](#controls-and-governance). Orders authorized by delegated keys must include nonces with timestamps between the creation and expiration of the delegated key. Orders remain valid after a delegated key’s expiration, unless the delegated key has been invalidated.
- Delegated keys may be revoked off-chain or invalidated on chain via [nonce invalidation](#nonces-and-invalidation). While revocation is convenient and gas-free, invalidation protects against some additional attack scenarios.
- Delegated keys may only authorize order placement and cancellation. They cannot authorize other actions such as deposits, withdrawals, or transfers.

## Cross-Chain Bridge Protocol Support

In order to support seamless cross-chain [deposits](#deposit) and [withdrawals](#withdraw), Ikon includes an extensible set of adapter contracts for bridge protocol integration. The primary set of adapter contracts supports cross-chain activity via [LayerZero](https://layerzero.network/), including deposits and withdrawals for Arbitrum, Avalanche, Base, Berachain, BNB Chain, Ethereum, and Optimism.

For deposits, adapters receive bridged funds and call Exchange’s `deposit` function with the provided destination wallet address. Only protocols that implement single transaction bridge-and-call functionality are supported.

Cross-chain withdrawal requests are signed by custody wallets, similar to withdrawal requests to the local chain, but include an additional `payload` field. Ikon’s withdrawal logic validates the request’s adapter address, transfers the funds to the adapter, then calls the adapter’s `withdrawQuoteAsset` with the `payload` parameter. `payload` ABI-encodes the necessary parameters for the protocol’s bridge function to deliver funds to the destination chain. If the bridge call fails, funds are redeposited to the Exchange.

Updates to the set of valid adapter contract addresses are subject to a governance delay for safety. See [controls and governance](#controls-and-governance) for details.

## Controls and Governance

The Ikon controls and governance design is captured in its own [spec](./GOVERNANCE.md).

## Additional Mechanics

### Upgradability

Ikon includes an upgrade model that allows contract logic upgrades within major releases without requiring users to move or redeposit funds.

- In Ikon, exchange state data continues to be stored in the Exchange contract rather than an external contract. Wallet balance information, captured in `_balanceTracking`, is the primary data that must migrate in the case of an upgrade. Ikon includes a lazy balance loading mechanism in the form of BalanceTracking’s `loadBalance*` functions to seamlessly maintain balance information at a minimum of gas overhead.
- `Constants.EIP_712_DOMAIN_VERSION` is incremented as part of any upgrade. As a result, open orders and active delegated keys must be replaced, and it is unnecessary to migrate `_completedOrderHashes`, `_completedTransferHashes`, `_completedWithdrawalHashes`, `_partiallyFilledOrderQuantitiesInPips`, and `_nonceInvalidations`. `_walletExits` are also unnecessary to migrate as users may exit wallets again.
- `_depositIndex` is manually set on deployment via a call to `setDepositIndex`.

The Custodian contract also includes the ability to migrate a held asset from one token contract to another. Asset migrations are subject to a governance delay for safety. See [controls and governance](#controls-and-governance) for details.

### Offline Operation

While not expected as part of normal operations, Kuma’s off-chain components occasionally may not be available for online operation. Ikon includes support for recovery to online operation and ensures access to user funds during offline operation.

- Some functionality, such as [Wallet In Maintenance During System Recovery](#wallet-in-maintenance-during-system-recovery) liquidation and [Exit Fund Closure](#exit-fund-closure) deleveraging are included solely to aid in offline system recovery.
- Wallet exits provide a mechanism for users to withdraw funds from the exchange in offline scenarios. **The value of open positions during exit withdrawals is different from the value of open positions in other situations.** See [wallet exits](#wallet-exits) for details.
- Any positive exit fund wallet USDC balance may be withdrawn after a period determined by `Constants.EXIT_FUND_WITHDRAW_DELAY_IN_S`. Exchange’s `_exitFundPositionOpenedAtBlockTimestamp` tracks the block timestamp at which the exit fund first acquires a position, starting the withdrawal delay clock.

### Nonces and Invalidation

Orders, withdrawals, transfers, and delegated key authorizations include nonces to prevent replay attacks. Kuma uses [version-1 UUIDs](https://en.wikipedia.org/wiki/Universally_unique_identifier#Version_1_(date-time_and_MAC_address)) as nonces, which include a timestamp as part of the value.

Kuma’s hybrid off-chain/on-chain architecture is vulnerable to a canceled-order submission attack if the off-chain components are compromised. In this scenario, an attacker gains access to the dispatcher wallet and a set of canceled orders by compromising the off-chain order book. Because the orders themselves include valid signatures from the placing wallet, the contracts cannot distinguish between active orders placed by users and those the user has since canceled. A similar issue applies to [delegated key](#delegated-keys) authorizations.

Nonce invalidation via `invalidateNonce` allows users to invalidate all orders and delegated keys prior to a specified nonce, making it impossible to submit those orders or use those delegated key authorizations in an attack. The [controls and governance](#controls-and-governance) spec covers the exact mechanics and parameters of the mechanism.

### Precision and Pips

Ikon normalizes all quantities to 8 decimals of precision, with 1e-8 referred to as a "pip". Deposits and withdrawals automatically account for USDC native token precision, as do accessors to ChainLink oracle pricing data, using `AssetUnitConversions`’ helper functions. Due to integer rounding issues, many validation calculations add a 1 pip tolerance to expected values.

### Quote Asset and Quote Token

All Ikon markets are quoted in USD and wallet quote balances are denominated in USD. In practice, however, deposits and withdrawals are made in USDC. While there are small variations in price between USD and USDC, USDC deposits and withdrawals are credited on a 1:1 basis to USD. The Ikon contract codebase refers to USD as the quote asset and USDC as the quote token.

### Fees

In Ikon, all fees are denominated in USD and are credited or debited from wallets’ quote balances. Maker trade fees may be negative, indicating a fee credit, in the case of maker fee rebate promotions.

<!-- ## Bug Bounty -->

<!-- The smart contracts in this repo are covered by a [bug bounty via Immunefi](https://www.immunefi.com/bounty/kuma). -->

## License

The Kuma Ikon Smart Contracts and related code are released under the [MIT License](https://spdx.org/licenses/MIT.html).
