// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {FolioScript} from "./FolioScript.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {TradeProbe} from "./TradeProbe.sol";

/**
 * @title Unpause
 * @notice Releases the platform-wide emergency stop and confirms trading is
 *         open again.
 *
 * ```
 * source .env
 * forge script contracts/script/Unpause.s.sol:Unpause \
 *   --rpc-url robinhood-mainnet --broadcast -vvv
 * ```
 *
 * `DEPLOYER_PRIVATE_KEY` must hold the factory owner's key.
 *
 * The verification is the mirror of the one in {Pause}: a `getBuyQuote` read
 * plus a locally simulated `buy`, neither broadcast, against the state left
 * behind by the unpause. A quote that prices and a buy that no longer reverts
 * with `TradingPaused()` together mean the curve is live again.
 */
contract Unpause is FolioScript {
    /// @notice `DEPLOYER_PRIVATE_KEY` is not the factory owner.
    error NotFactoryOwner(address owner, address caller);

    function run() external onlySupportedNetwork {
        FolioFactory factory = loadFactory();
        address owner = factory.owner();
        address caller = deployer();

        header(string.concat("Release emergency pause - ", networkName()));
        console2.log("  Factory       : %s", vm.toString(address(factory)));
        console2.log("  Factory owner : %s", vm.toString(owner));
        console2.log("  Your wallet   : %s", vm.toString(caller));
        console2.log("  Currently     : %s", factory.paused() ? "PAUSED" : "active");
        console2.log("");

        if (owner != caller) revert NotFactoryOwner(owner, caller);
        if (!factory.paused()) {
            console2.log("  Not paused - nothing to do.");
            return;
        }

        confirm("UNPAUSE the platform and resume trading");

        vm.startBroadcast(deployerKey());
        factory.unpause();
        vm.stopBroadcast();

        header("Unpaused");
        console2.log("  factory.paused() : %s", factory.paused() ? "true" : "false");
        console2.log("  Explorer         : %s", addressLink(address(factory)));

        _verifyTradingResumed();

        console2.log("");
    }

    /// @dev Locally simulated, nothing broadcast. See the note in `Pause`.
    function _verifyTradingResumed() private {
        (FolioToken token, bool found) = tryLoadToken();
        if (!found) {
            header("Verification skipped");
            console2.log("  No launch recorded yet, so there is nothing to test against.");
            return;
        }

        header("Verifying trading resumed (local simulation, nothing broadcast)");
        console2.log("  Token : %s (%s)", token.symbol(), vm.toString(address(token)));
        console2.log("  token.tradingPaused() : %s", token.tradingPaused() ? "true" : "false");

        (uint256 out,,) = token.getBuyQuote(0.001 ether);
        console2.log("  Quote for 0.001 ETH   : %s %s", formatTokens(out), token.symbol());
        console2.log("");

        TradeProbe probe = new TradeProbe();
        vm.deal(address(probe), 1 ether);

        (bool ok, bytes memory err) = probe.tryBuy(token, 0.0001 ether);
        if (ok) {
            console2.log("  buy()  : succeeded <- trading is live again");
            console2.log(
                "           probe received %s %s",
                formatTokens(token.balanceOf(address(probe))),
                token.symbol()
            );
        } else if (err.length >= 4 && bytes4(err) == FolioToken.TradingPaused.selector) {
            console2.log("  buy()  : still TradingPaused() - the unpause did not take effect.");
        } else if (err.length >= 4 && bytes4(err) == FolioToken.CurveClosed.selector) {
            console2.log("  buy()  : CurveClosed() - this launch graduated or hit its cap.");
            console2.log("           Not a pause problem; selling is still open.");
        } else {
            console2.log("  buy()  : reverted for some other reason - inspect with -vvvv.");
        }
    }
}
