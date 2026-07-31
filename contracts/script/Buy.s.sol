// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {FolioScript} from "./FolioScript.sol";
import {FolioToken} from "../src/FolioToken.sol";

/**
 * @title Buy
 * @notice Buys a small amount off a launch's curve and prints what came back.
 *
 * ```
 * source .env
 * BUY_ETH=10000000000000000 forge script contracts/script/Buy.s.sol:Buy \
 *   --rpc-url base-sepolia --broadcast -vvv
 * ```
 *
 * Acts on `FOLIO_TOKEN` if set, otherwise on the `lastToken` recorded for
 * whichever network `--rpc-url` selected — `deployments/<network>.json`.
 *
 * ## Slippage
 *
 * The script quotes with `getBuyQuote` and sets `minTokensOut` to that quote
 * less `BUY_SLIPPAGE_BPS` (default 100 = 1%), rather than passing zero. On a
 * public mempool a zero floor means accepting whatever price a sandwich leaves
 * you, and a manual-verification script is exactly where that habit should not
 * be set. Set `BUY_SLIPPAGE_BPS=10000` to disable the floor deliberately.
 *
 * The token figure printed is the caller's measured balance delta, so it
 * reflects what actually settled rather than what the quote predicted.
 */
contract Buy is FolioScript {
    /// @dev Snapshot taken before the trade, so the report can show deltas.
    ///      Grouped into a struct because `run` otherwise runs out of stack.
    struct Before {
        uint256 price;
        uint256 tokens;
        uint256 eth;
    }

    function run() external onlySupportedNetwork {
        FolioToken token = loadToken();
        uint256 ethIn = vm.envOr("BUY_ETH", uint256(0.01 ether));

        header(string.concat("Buy - ", networkName()));
        console2.log("  Token   : %s (%s)", token.symbol(), vm.toString(address(token)));
        console2.log("  Buyer   : %s", vm.toString(deployer()));
        console2.log("  Sending : %s ETH", formatEth(ethIn));
        console2.log("");

        if (token.tradingPaused()) {
            console2.log("  Trading is PAUSED on the factory - this buy would revert.");
            console2.log("  Run Unpause.s.sol from the owner wallet first.");
            return;
        }
        if (token.graduated()) {
            console2.log("  This launch has GRADUATED - buys are closed. Selling still works.");
            return;
        }
        if (token.ethHeadroom() == 0) {
            console2.log("  This launch is at its reserve cap - buys are closed.");
            return;
        }

        uint256 minOut = _quote(token, ethIn);

        Before memory snap =
            Before(token.currentPrice(), token.balanceOf(deployer()), deployer().balance);

        confirm(string.concat("buy ", formatEth(ethIn), " ETH worth of ", token.symbol()));

        uint256 gasBefore = gasleft();
        vm.startBroadcast(deployerKey());
        token.buy{value: ethIn}(minOut);
        vm.stopBroadcast();

        _report(token, snap, gasBefore - gasleft());
    }

    /// @dev Prints the quote and returns the slippage-adjusted floor.
    function _quote(FolioToken token, uint256 ethIn) private view returns (uint256 minOut) {
        uint256 slippageBps = vm.envOr("BUY_SLIPPAGE_BPS", uint256(100));
        (uint256 out, uint256 spent, uint256 refund) = token.getBuyQuote(ethIn);
        minOut = slippageBps >= 10_000 ? 0 : (out * (10_000 - slippageBps)) / 10_000;

        console2.log("  Quote");
        console2.log("    Tokens out   : %s %s", formatTokens(out), token.symbol());
        console2.log("    ETH spent    : %s ETH", formatEth(spent));
        console2.log("    Refund       : %s ETH", formatEth(refund));
        console2.log(
            "    Min accepted : %s (%s slippage)", formatTokens(minOut), formatBps(slippageBps)
        );
    }

    /// @dev The post-trade report, in its own frame for stack room.
    function _report(FolioToken token, Before memory snap, uint256 gasUsed) private view {
        address buyer = deployer();
        uint256 received = token.balanceOf(buyer) - snap.tokens;

        header("Bought");
        console2.log("  Tokens received : %s %s", formatTokens(received), token.symbol());
        console2.log(
            "  Token balance   : %s %s", formatTokens(token.balanceOf(buyer)), token.symbol()
        );
        console2.log(
            "  ETH balance     : %s -> %s ETH", formatEth(snap.eth), formatEth(buyer.balance)
        );
        console2.log("  Gas used        : ~%s", vm.toString(gasUsed));
        console2.log("");
        console2.log(
            "  Price   : %s -> %s ETH / token",
            formatPrice(snap.price),
            formatPrice(token.currentPrice())
        );
        console2.log("  Reserve : %s ETH", formatEth(token.getReserveBalance()));
        console2.log(
            "  Sold    : %s / %s",
            formatTokens(token.tokensSold()),
            formatTokens(token.curveSupply())
        );
        console2.log("  Headroom: %s ETH", formatEth(token.ethHeadroom()));

        if (token.graduated()) {
            console2.log("");
            console2.log("  This buy GRADUATED the launch - buys are now closed.");
        }

        console2.log("");
        console2.log("  Your holdings : %s", tokenLink(address(token), buyer));
        console2.log("  Token         : %s", addressLink(address(token)));
        console2.log("");
    }
}
