// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {FolioScript} from "./FolioScript.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {TradeProbe} from "./TradeProbe.sol";

/**
 * @title Pause
 * @notice Engages the platform-wide emergency stop from the owner wallet, then
 *         proves it actually stopped trading.
 *
 * ```
 * source .env
 * forge script contracts/script/Pause.s.sol:Pause \
 *   --rpc-url robinhood-mainnet --broadcast -vvv
 * ```
 *
 * `DEPLOYER_PRIVATE_KEY` must hold the factory owner's key. The script checks
 * that before asking for confirmation, so a wrong wallet fails with a readable
 * message instead of an `OwnableUnauthorizedAccount` revert.
 *
 * ## How the verification works
 *
 * After broadcasting the pause, the script attempts a `buy` and a `sell`
 * *without* `vm.broadcast`. Calls outside a broadcast execute against the
 * script's local fork of real chain state — including the pause that was just
 * applied — and are never submitted to the network. So this is a genuine test
 * of post-pause behaviour that costs no gas and cannot accidentally trade.
 *
 * Both are expected to revert with `TradingPaused()`. The script reports what
 * it actually saw rather than asserting silently, because the point of a manual
 * verification step is to be read.
 *
 * ## What pause does not do
 *
 * It does not stop `claimFees`, does not stop any view function, and cannot
 * move anyone's funds. Read the halt plainly: while it is engaged, holders
 * cannot sell either. That is the cost of containment, and it is why
 * {Unpause} exists.
 */
contract Pause is FolioScript {
    /// @notice `DEPLOYER_PRIVATE_KEY` is not the factory owner.
    error NotFactoryOwner(address owner, address caller);

    function run() external onlySupportedNetwork {
        FolioFactory factory = loadFactory();
        address owner = factory.owner();
        address caller = deployer();

        header(string.concat("Emergency pause - ", networkName()));
        console2.log("  Factory        : %s", vm.toString(address(factory)));
        console2.log("  Factory owner  : %s", vm.toString(owner));
        console2.log("  Your wallet    : %s", vm.toString(caller));
        console2.log("  Currently      : %s", factory.paused() ? "PAUSED" : "active");
        console2.log("");

        if (owner != caller) revert NotFactoryOwner(owner, caller);
        if (factory.paused()) {
            console2.log("  Already paused - nothing to do.");
            return;
        }

        console2.log("  This halts new launches AND buying and selling on every");
        console2.log("  existing launch. Holders will not be able to sell while it");
        console2.log("  is engaged. claimFees and all view functions stay open.");

        confirm("PAUSE the entire platform");

        vm.startBroadcast(deployerKey());
        factory.pause();
        vm.stopBroadcast();

        header("Paused");
        console2.log("  factory.paused() : %s", factory.paused() ? "true" : "false");
        console2.log("  Explorer         : %s", addressLink(address(factory)));

        _verifyTradingHalted();

        header("Next");
        console2.log("  Release it with:");
        console2.log("    forge script contracts/script/Unpause.s.sol:Unpause \\");
        console2.log("      --rpc-url %s --broadcast -vvv", networkSlug());
        console2.log("");
    }

    /**
     * @dev Simulates a buy and a sell locally against the just-paused state.
     *      Nothing here is broadcast.
     */
    function _verifyTradingHalted() private {
        (FolioToken token, bool found) = tryLoadToken();
        if (!found) {
            header("Verification skipped");
            console2.log("  No launch recorded yet, so there is nothing to test buy/sell against.");
            console2.log("  Set FOLIO_TOKEN=0x... to verify against a specific launch.");
            return;
        }

        header("Verifying trading is halted (local simulation, nothing broadcast)");
        console2.log("  Token : %s (%s)", token.symbol(), vm.toString(address(token)));
        console2.log("  token.tradingPaused() : %s", token.tradingPaused() ? "true" : "false");
        console2.log("");

        TradeProbe probe = new TradeProbe();
        vm.deal(address(probe), 1 ether);

        (bool boughtOk, bytes memory buyErr) = probe.tryBuy(token, 0.0001 ether);
        if (boughtOk) {
            console2.log("  buy()  : DID NOT REVERT - the pause is not reaching this token.");
            console2.log("           Check that the token's factory is the one just paused.");
        } else {
            console2.log("  buy()  : reverted, %s", _describe(buyErr));
        }

        (bool soldOk, bytes memory sellErr) = probe.trySell(token, 1e18);
        if (soldOk) {
            console2.log("  sell() : DID NOT REVERT - the pause is not reaching this token.");
        } else {
            console2.log("  sell() : reverted, %s", _describe(sellErr));
        }

        console2.log("");
        console2.log("  Expected: both reverted with TradingPaused().");
    }

    /**
     * @dev Names the revert selector when it is one the token declares, so the
     *      output distinguishes "the pause worked" from "it failed for some
     *      other reason", which is the entire point of the check.
     */
    function _describe(bytes memory err) private pure returns (string memory) {
        if (err.length < 4) return "with no reason data";
        bytes4 sel = bytes4(err);
        if (sel == FolioToken.TradingPaused.selector) return "TradingPaused() <- correct";
        if (sel == FolioToken.CurveClosed.selector) {
            return "CurveClosed() <- graduated or at cap, not the pause";
        }
        if (sel == FolioToken.PaymentTooSmall.selector) {
            return "PaymentTooSmall() <- NOT the pause";
        }
        if (sel == FolioToken.ExceedsCirculating.selector) {
            return "ExceedsCirculating() <- NOT the pause";
        }
        if (sel == FolioToken.PayoutTooSmall.selector) return "PayoutTooSmall() <- NOT the pause";
        return "with an unrecognised error";
    }
}
