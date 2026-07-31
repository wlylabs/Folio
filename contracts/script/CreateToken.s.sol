// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {FolioScript} from "./FolioScript.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";

/**
 * @title CreateToken
 * @notice Launches one token through the deployed factory and records it as
 *         `lastToken`, so the buy/sell/reserve scripts can run with no
 *         arguments.
 *
 * ```
 * source .env
 * TOKEN_NAME="Midnight Kettle" TOKEN_SYMBOL=KETL TOKEN_SUPPLY=1000000 \
 * forge script contracts/script/CreateToken.s.sol:CreateToken \
 *   --rpc-url base-sepolia --broadcast -vvv
 * ```
 *
 * `TOKEN_MAX_RESERVE_CAP` is optional and, when set, may only *tighten* the
 * platform default — the factory rejects anything larger. Leaving it at zero
 * takes the platform's own cap.
 *
 * The new address is recovered from the factory's return value rather than
 * parsed out of logs, which is what makes it exact even when several launches
 * land in the same block.
 */
contract CreateToken is FolioScript {
    function run() external onlySupportedNetwork returns (FolioToken token) {
        FolioFactory factory = loadFactory();

        string memory name = vm.envOr("TOKEN_NAME", string("Folio Testnet Launch"));
        string memory symbol = vm.envOr("TOKEN_SYMBOL", string("FOLIO"));
        uint256 supply = vm.envOr("TOKEN_SUPPLY", uint256(1_000_000));
        uint256 cap = vm.envOr("TOKEN_MAX_RESERVE_CAP", uint256(0));

        header(string.concat("Create launch - ", networkName()));
        console2.log("  Factory      : %s", vm.toString(address(factory)));
        console2.log("  Name         : %s", name);
        console2.log("  Symbol       : %s", symbol);
        console2.log("  Whole supply : %s", vm.toString(supply));
        if (cap == 0) {
            console2.log("  Reserve cap  : platform default");
        } else {
            console2.log("  Reserve cap  : %s ETH (tightened by creator)", formatEth(cap));
        }

        confirm(string.concat("create the launch '", name, "'"));

        uint256 gasBefore = gasleft();
        vm.startBroadcast(deployerKey());
        address created = cap == 0
            ? factory.createToken(name, symbol, supply)
            : factory.createToken(name, symbol, supply, cap);
        vm.stopBroadcast();
        uint256 gasUsed = gasBefore - gasleft();

        token = FolioToken(created);

        header("Launch created");
        console2.log("  Token       : %s", vm.toString(created));
        console2.log("  Creator     : %s", vm.toString(token.creator()));
        console2.log("  Gas used    : ~%s", vm.toString(gasUsed));
        console2.log("");
        console2.log("  Curve supply    : %s %s", formatTokens(token.curveSupply()), symbol);
        console2.log("  Opening price   : %s ETH / token", formatPrice(token.currentPrice()));
        console2.log("  Market cap      : %s ETH", formatEth(token.marketCap()));
        console2.log("  Fee per leg     : %s", formatBps(token.feeBps()));
        console2.log("  Reserve cap     : %s ETH", formatEth(token.maxReserveCap()));
        console2.log("  Graduates at    : %s ETH", formatEth(token.graduationThreshold()));
        console2.log("");
        console2.log("  Registered by factory : %s", factory.isFolioToken(created) ? "yes" : "NO");
        console2.log("  Explorer              : %s", addressLink(created));

        _recordLastToken(created);

        header("Next");
        console2.log("  Buy into it:");
        console2.log("    BUY_ETH=0.01ether forge script contracts/script/Buy.s.sol:Buy \\");
        console2.log("      --rpc-url %s --broadcast -vvv", networkSlug());
        console2.log("");
    }

    /**
     * @dev Points `lastToken` in the deployment record at the new launch.
     *
     *      `vm.writeJson` updates that one key and leaves every other field the
     *      deploy script wrote intact, so this cannot truncate the record the
     *      way rebuilding the file would. The address is on stdout regardless,
     *      so a failed write costs nothing but a manual `FOLIO_TOKEN=`.
     */
    function _recordLastToken(address token) private {
        if (!vm.exists(deploymentsPath())) {
            console2.log("  No deployment record to update.");
            console2.log("  Pass FOLIO_TOKEN=%s to the next script.", vm.toString(token));
            return;
        }
        vm.writeJson(vm.toString(token), deploymentsPath(), ".lastToken");
        console2.log("  Recorded as lastToken in %s", deploymentsPath());
    }
}
