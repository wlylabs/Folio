// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {BaseSepoliaScript} from "./BaseSepoliaScript.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";

/**
 * @title CheckReserve
 * @notice Prints a launch's reserve, its outstanding sell obligation, and the
 *         margin between them. Read-only: it broadcasts nothing, costs nothing,
 *         and is safe to run at any time — including while the platform is
 *         paused, since every view on the token stays callable then.
 *
 * ```
 * source .env
 * forge script contracts/script/CheckReserve.s.sol:CheckReserve --rpc-url base-sepolia
 * ```
 *
 * ## What to look at
 *
 * `reserveHealthBps` is the number that matters. It is the reserve as a
 * fraction of what the curve owes every current holder, in basis points:
 *
 * - `10000` — exactly covered. This is the design target and the normal reading.
 * - above `10000` — accumulated rounding surplus. Fine, and expected to creep
 *   up slowly as trades round in the reserve's favour.
 * - below `10000` — **should be impossible.** The curve prices both legs off the
 *   same `k`, so the reserve is by construction sufficient. A reading under
 *   10000 means the curve maths is wrong, and is the one condition on this
 *   whole page worth pausing the platform over.
 *
 * The script also compares `ethReserve` against the contract's actual ETH
 * balance. The balance should be at least reserve + unclaimed fees; anything
 * above that is ETH someone force-sent, which the curve deliberately ignores.
 */
contract CheckReserve is BaseSepoliaScript {
    function run() external view onlyBaseSepolia {
        FolioFactory factory = loadFactory();
        FolioToken token = loadToken();

        uint256 reserve = token.getReserveBalance();
        uint256 obligation = token.getOutstandingSellObligation();
        uint256 healthBps = token.reserveHealthBps();
        uint256 fees = token.feesAccrued();
        uint256 balance = address(token).balance;

        header("Reserve status - Base Sepolia");
        console2.log("  Token   : %s (%s)", token.symbol(), vm.toString(address(token)));
        console2.log("  Name    : %s", token.name());
        console2.log("  Creator : %s", vm.toString(token.creator()));
        console2.log("  Factory : %s", vm.toString(address(factory)));

        header("Solvency");
        console2.log("  ETH reserve             : %s ETH", formatEth(reserve));
        console2.log("  Outstanding sell oblig. : %s ETH", formatEth(obligation));
        if (reserve >= obligation) {
            console2.log("  Surplus                 : %s ETH", formatEth(reserve - obligation));
        } else {
            console2.log("  SHORTFALL               : %s ETH", formatEth(obligation - reserve));
        }
        console2.log(
            "  Reserve health          : %s bps (%s)", vm.toString(healthBps), _verdict(healthBps)
        );

        header("Balance reconciliation");
        console2.log("  Contract ETH balance : %s ETH", formatEth(balance));
        console2.log("  Curve reserve        : %s ETH", formatEth(reserve));
        console2.log("  Unclaimed fees       : %s ETH", formatEth(fees));
        uint256 accountedFor = reserve + fees;
        if (balance >= accountedFor) {
            console2.log(
                "  Unaccounted (force-sent, ignored by the curve) : %s ETH",
                formatEth(balance - accountedFor)
            );
        } else {
            console2.log(
                "  UNDER-FUNDED by %s ETH - balance is below reserve + fees.",
                formatEth(accountedFor - balance)
            );
        }

        header("Curve");
        console2.log("  Current price     : %s ETH / token", formatPrice(token.currentPrice()));
        console2.log(
            "  Tokens sold       : %s %s", formatTokens(token.tokensSold()), token.symbol()
        );
        console2.log(
            "  Curve supply      : %s %s", formatTokens(token.curveSupply()), token.symbol()
        );
        console2.log(
            "  Curve inventory   : %s %s", formatTokens(token.curveTokenReserve()), token.symbol()
        );
        console2.log("  Market cap (FDV)  : %s ETH", formatEth(token.marketCap()));
        console2.log("  Circulating cap   : %s ETH", formatEth(token.circulatingMarketCap()));

        header("Limits and state");
        console2.log("  Reserve cap          : %s ETH", formatEth(token.maxReserveCap()));
        console2.log("  Graduation threshold : %s ETH", formatEth(token.graduationThreshold()));
        console2.log("  ETH headroom         : %s ETH", formatEth(token.ethHeadroom()));
        console2.log("  Graduated            : %s", token.graduated() ? "yes - buys closed" : "no");
        console2.log(
            "  Trading paused       : %s", token.tradingPaused() ? "YES - buy/sell revert" : "no"
        );
        console2.log("  Fee per leg          : %s", formatBps(token.feeBps()));

        header("Verdict");
        if (healthBps < 10_000) {
            console2.log("  FAIL - reserve is below its obligation. This should be unreachable.");
            console2.log("         Pause the platform and stop here:");
            console2.log("         forge script contracts/script/Pause.s.sol:Pause \\");
            console2.log("           --rpc-url base-sepolia --broadcast");
        } else if (balance < accountedFor) {
            console2.log("  FAIL - contract holds less ETH than reserve + unclaimed fees.");
        } else {
            console2.log("  OK - every holder can sell back at the quoted price.");
        }
        console2.log("");
        console2.log("  Token on Basescan : %s", addressLink(address(token)));
        console2.log("");
    }

    function _verdict(uint256 healthBps) private pure returns (string memory) {
        if (healthBps < 10_000) return "BELOW TARGET - investigate";
        if (healthBps == 10_000) return "exactly covered";
        return "covered, with rounding surplus";
    }
}
