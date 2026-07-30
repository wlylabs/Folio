// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {BaseSepoliaScript} from "./BaseSepoliaScript.sol";
import {FolioToken} from "../src/FolioToken.sol";

/**
 * @title Sell
 * @notice Sells part of a holding back to the curve and prints the ETH received.
 *
 * ```
 * source .env
 * SELL_BPS=5000 forge script contracts/script/Sell.s.sol:Sell \
 *   --rpc-url base-sepolia --broadcast -vvv
 * ```
 *
 * Two ways to say how much:
 *
 * - `SELL_BPS` — a fraction of the current balance in basis points. The default
 *   is 5000, i.e. half. This is the one to use for manual verification, because
 *   it stays correct whatever the previous buy happened to return.
 * - `SELL_TOKENS` — an exact amount in token units (18 decimals). Overrides
 *   `SELL_BPS` when set.
 *
 * The ETH figure printed is the wallet's measured balance delta *plus* the gas
 * the transaction burned, so it reports what the curve paid rather than what
 * the wallet netted after fees. Both numbers are shown, because on a testnet
 * the difference between them is the entire reason a sell can look like it lost
 * money.
 */
contract Sell is BaseSepoliaScript {
    /// @notice `SELL_BPS` above 100%.
    error InvalidSellFraction();
    /// @notice The wallet holds nothing to sell.
    error NothingToSell();

    function run() external onlyBaseSepolia {
        FolioToken token = loadToken();
        address seller = deployer();
        uint256 balance = token.balanceOf(seller);

        header("Sell - Base Sepolia");
        console2.log("  Token   : %s (%s)", token.symbol(), vm.toString(address(token)));
        console2.log("  Seller  : %s", vm.toString(seller));
        console2.log("  Holding : %s %s", formatTokens(balance), token.symbol());
        console2.log("");

        if (balance == 0) revert NothingToSell();
        if (token.tradingPaused()) {
            console2.log("  Trading is PAUSED on the factory - this sell would revert.");
            console2.log("  Run Unpause.s.sol from the owner wallet first.");
            return;
        }

        uint256 amount = _amountToSell(balance);
        uint256 slippageBps = vm.envOr("SELL_SLIPPAGE_BPS", uint256(100));

        uint256 quotedOut = token.getSellPrice(amount);
        uint256 minOut = slippageBps >= 10_000 ? 0 : (quotedOut * (10_000 - slippageBps)) / 10_000;

        console2.log("  Selling      : %s %s", formatTokens(amount), token.symbol());
        console2.log(
            "  Quoted ETH   : %s ETH (net of %s fee)",
            formatEth(quotedOut),
            formatBps(token.feeBps())
        );
        console2.log(
            "  Min accepted : %s ETH (%s slippage)", formatEth(minOut), formatBps(slippageBps)
        );

        uint256 priceBefore = token.currentPrice();
        uint256 ethBefore = seller.balance;

        confirm(string.concat("sell ", formatTokens(amount), " ", token.symbol()));

        uint256 gasBefore = gasleft();
        vm.startBroadcast(deployerKey());
        token.sell(amount, minOut);
        vm.stopBroadcast();
        uint256 gasUsed = gasBefore - gasleft();

        uint256 walletDelta = seller.balance > ethBefore ? seller.balance - ethBefore : 0;

        header("Sold");
        console2.log("  Curve paid      : %s ETH", formatEth(quotedOut));
        console2.log("  Wallet delta    : +%s ETH (after gas)", formatEth(walletDelta));
        console2.log("  Tokens burned   : %s %s", formatTokens(amount), token.symbol());
        console2.log(
            "  Remaining       : %s %s", formatTokens(token.balanceOf(seller)), token.symbol()
        );
        console2.log("  Gas used        : ~%s", vm.toString(gasUsed));
        console2.log("");
        console2.log(
            "  Price   : %s -> %s ETH / token",
            formatPrice(priceBefore),
            formatPrice(token.currentPrice())
        );
        console2.log("  Reserve : %s ETH", formatEth(token.getReserveBalance()));
        console2.log(
            "  Sold    : %s / %s %s",
            formatTokens(token.tokensSold()),
            formatTokens(token.curveSupply()),
            token.symbol()
        );
        console2.log("");
        console2.log("  Token : %s", addressLink(address(token)));
        console2.log("");
    }

    /// @dev `SELL_TOKENS` when set, otherwise `SELL_BPS` of the balance.
    function _amountToSell(uint256 balance) private view returns (uint256 amount) {
        uint256 exact = vm.envOr("SELL_TOKENS", uint256(0));
        if (exact != 0) return exact > balance ? balance : exact;

        uint256 bps = vm.envOr("SELL_BPS", uint256(5_000));
        if (bps == 0 || bps > 10_000) revert InvalidSellFraction();
        amount = (balance * bps) / 10_000;
        // A tiny holding can floor to zero here; selling everything is the only
        // sensible reading of "sell half of dust".
        if (amount == 0) amount = balance;
    }
}
