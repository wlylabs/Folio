// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {FolioScript} from "./FolioScript.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";

/**
 * @title DeployFactory
 * @notice Deploys `FolioFactory` to either supported chain and records the
 *         result in `deployments/<network>.json`.
 *
 * The factory's constructor deploys the shared `FolioToken` implementation, so
 * this one transaction produces both addresses and there is no window in which
 * a factory exists pointing at an implementation somebody else deployed.
 *
 * ## Running it
 *
 * ```
 * source .env
 * forge script contracts/script/DeployFactory.s.sol:DeployFactory \
 *   --rpc-url robinhood-mainnet --broadcast --verify -vvv
 * ```
 *
 * The same script, unmodified, deploys to Robinhood Chain — the chain is chosen
 * by `--rpc-url` alone, and every chain-shaped value (record path, explorer,
 * banner) comes from the {NetworkProfile} the guard resolved. The bytecode is
 * identical on both: nothing here reads `block.chainid`, and
 * `evm_version = "paris"` keeps the opcode set to what both chains run.
 * Robinhood verifies through Blockscout rather than Etherscan, so its deploy
 * takes two extra flags — see DEPLOYMENT.md.
 *
 * Robinhood Chain is a mainnet. `--rpc-url robinhood-mainnet` spends real ETH
 * on gas and puts a factory in front of real buyers, so the confirmation banner
 * is the last thing between the decision and the broadcast: read the chain id
 * on it. There is no testnet to rehearse on — Base Sepolia was removed — so
 * rehearse against a local fork (`anvil --fork-url $ROBINHOOD_MAINNET_RPC_URL`)
 * and point the script at that before broadcasting for real. The deploy is
 * cheap enough to rehearse and expensive enough to regret.
 *
 * Re-running deploys a *second, independent* factory. That is intentional —
 * nothing here mutates a live factory — but it means the JSON record is
 * overwritten, so the previous address survives only in git history and in
 * `broadcast/`. The script prints the address it is about to replace as part of
 * the confirmation, so overwriting is a decision rather than a surprise.
 *
 * ## Curve terms
 *
 * The starting `CurveConfig` is read from the environment with the defaults
 * below, all of which are `FolioFactory`-admissible. They are inherited
 * numbers, chosen when Folio still had a chain that handed out its ETH for
 * free: a 2 ETH virtual
 * reserve, a 5 ETH blast radius, graduation at 4 ETH, 1% per leg, and a
 * price-move alert at a doubling. On Robinhood Chain those are real amounts and
 * the defaults are almost certainly not what you want — set
 * `FACTORY_VIRTUAL_ETH_RESERVE`, `FACTORY_MAX_RESERVE_CAP` and
 * `FACTORY_GRADUATION_THRESHOLD` deliberately for a mainnet deploy. The banner
 * prints all five before anything is signed. `setDefaultConfig` can retune them
 * afterwards for future launches without redeploying.
 */
contract DeployFactory is FolioScript {
    function run() external onlySupportedNetwork returns (FolioFactory factory) {
        CurveConfig memory config = _configFromEnv();
        address owner = vm.envOr("FACTORY_OWNER", deployer());

        header(string.concat("Deploy FolioFactory - ", networkName()));
        console2.log("  Owner (emergency stop) : %s", vm.toString(owner));
        console2.log("  virtualEthReserve      : %s ETH", formatEth(config.virtualEthReserve));
        console2.log("  maxReserveCap          : %s ETH", formatEth(config.maxReserveCap));
        console2.log("  graduationThreshold    : %s ETH", formatEth(config.graduationThreshold));
        console2.log("  feeBps                 : %s", formatBps(config.feeBps));
        console2.log("  priceMoveAlertBps      : %s", formatBps(config.priceMoveAlertBps));
        console2.log("  sniperWindowSeconds    : %s", vm.toString(config.sniperWindowSeconds));
        console2.log(
            "  sniperMaxEthPerWallet  : %s ETH", formatEth(config.sniperMaxEthPerWallet)
        );
        console2.log(
            "  migrator               : %s",
            config.migrator == address(0) ? "none (curve is terminal)" : vm.toString(config.migrator)
        );

        // Only when a factory was actually recorded. Every chain gets its
        // record committed before its first deploy, with the addresses left
        // empty, so "the file exists" and "there is an address to lose" are
        // different questions — and it is the second one this warning answers.
        if (vm.exists(deploymentsPath())) {
            address recorded = recordedAddress(vm.readFile(deploymentsPath()), ".factory");
            if (recorded != address(0)) {
                console2.log("");
                console2.log("  NOTE: a deployment record already exists and will be overwritten:");
                console2.log("        %s", vm.toString(recorded));
            }
        }

        confirm(string.concat("deploy a new FolioFactory to ", networkName()));

        uint256 gasBefore = gasleft();
        vm.startBroadcast(deployerKey());
        factory = new FolioFactory(owner, config);
        vm.stopBroadcast();
        uint256 gasUsed = gasBefore - gasleft();

        address implementation = factory.implementation();

        header("Deployed");
        console2.log("  Factory        : %s", vm.toString(address(factory)));
        console2.log("  Implementation : %s", vm.toString(implementation));
        console2.log("  Owner          : %s", vm.toString(factory.owner()));
        console2.log("  Gas used       : ~%s", vm.toString(gasUsed));
        console2.log("");
        console2.log("  Factory on explorer        : %s", addressLink(address(factory)));
        console2.log("  Implementation on explorer : %s", addressLink(implementation));

        _write(factory, implementation, owner, config);

        header("Next");
        console2.log("  1. Confirm both contracts show as verified on the explorer.");
        console2.log("  2. Create a test launch:");
        console2.log("     forge script contracts/script/CreateToken.s.sol:CreateToken \\");
        console2.log("       --rpc-url %s --broadcast -vvv", networkSlug());
        console2.log("");
    }

    /**
     * @dev Writes the deployment record.
     *
     *      Serialised by hand rather than with `vm.serializeJson`, so the file's
     *      shape is fixed here and legible in a diff. `lastToken` starts empty
     *      and `CreateToken` fills it in, which is what lets the interaction
     *      scripts run with no arguments at all.
     */
    function _write(
        FolioFactory factory,
        address implementation,
        address owner,
        CurveConfig memory config
    ) private {
        // Built in named stages rather than one long `string.concat`. A single
        // chain over every field is what pushes this function past the EVM's
        // 16-slot reach and fails the build with "stack too deep".
        string memory json = "{\n";
        json = string.concat(json, _str("network", networkSlug(), 2));
        json = string.concat(json, _num("chainId", block.chainid, 2));
        json = string.concat(json, _str("factory", vm.toString(address(factory)), 2));
        json = string.concat(json, _str("implementation", vm.toString(implementation), 2));
        json = string.concat(json, _str("owner", vm.toString(owner), 2));
        json = string.concat(json, _str("deployer", vm.toString(deployer()), 2));
        json = string.concat(json, _num("deployedAtBlock", block.number, 2));
        json = string.concat(json, _num("deployedAtTimestamp", block.timestamp, 2));
        json = string.concat(json, _str("explorer", _profile().explorer, 2));
        // Filled in by `CreateToken`, so the trading scripts need no arguments.
        json = string.concat(json, _str("lastToken", "", 2));

        json = string.concat(json, '  "defaultConfig": {\n');
        // Wei values are written as strings: they exceed 2^53 and would lose
        // precision the moment JavaScript parsed the file.
        json = string.concat(
            json, _str("virtualEthReserve", vm.toString(config.virtualEthReserve), 4)
        );
        json = string.concat(json, _str("maxReserveCap", vm.toString(config.maxReserveCap), 4));
        json = string.concat(
            json, _str("graduationThreshold", vm.toString(config.graduationThreshold), 4)
        );
        json = string.concat(json, _num("feeBps", config.feeBps, 4));
        // Last entry in the object, so no trailing comma.
        json = string.concat(
            json, '    "priceMoveAlertBps": ', vm.toString(uint256(config.priceMoveAlertBps)), "\n"
        );
        json = string.concat(json, "  }\n}\n");

        vm.writeFile(deploymentsPath(), json);
        console2.log("");
        console2.log("  Recorded in %s", deploymentsPath());
    }

    /// @dev One `"key": "value",` line, indented by `indent` spaces.
    function _str(string memory key, string memory value, uint256 indent)
        private
        pure
        returns (string memory)
    {
        return string.concat(_pad(indent), '"', key, '": "', value, '",\n');
    }

    /// @dev One `"key": value,` line with an unquoted number.
    function _num(string memory key, uint256 value, uint256 indent)
        private
        pure
        returns (string memory)
    {
        return string.concat(_pad(indent), '"', key, '": ', vm.toString(value), ",\n");
    }

    function _pad(uint256 spaces) private pure returns (string memory out) {
        for (uint256 i = 0; i < spaces; i++) {
            out = string.concat(out, " ");
        }
    }

    /// @dev Curve terms from the environment. The defaults are the inherited
    ///      ones described above — set them explicitly for a mainnet deploy.
    /// @dev `internal` rather than `private` so a test subclass can read the
    ///      shipped defaults back and hold them to the shape they claim — see
    ///      `FolioDeployDefaults.t.sol`. `forge script` owns `run`, so a seam is
    ///      the only way these numbers get checked before a mainnet deploy uses
    ///      them.
    function _configFromEnv() internal view returns (CurveConfig memory) {
        return CurveConfig({
            // The graduation threshold is the depth of whatever market comes
            // after the curve — every wei of the reserve is what a migrated pool
            // would be seeded with. Extracting `X` ETH from a pool of depth `D`
            // moves the price to `((D - X) / D) ** 2` of where it was, so a 4 ETH
            // graduation means a single 1 ETH sell costs 44% and the market the
            // launch graduates into is broken on arrival. At 10 ETH the same sell
            // costs 19%, which is a market.
            //
            // The virtual reserve rises with it on purpose. Aggression is the
            // *ratio* `(V + threshold) / V`, squared — holding it at 3 keeps the
            // curve's shape at the same 9x from open to graduation, so this is a
            // change of scale and not a steeper climb for late buyers. Drop `V`
            // back to 2 here and the same threshold would be 36x, which is a
            // different and much more extractive product.
            virtualEthReserve: vm.envOr("FACTORY_VIRTUAL_ETH_RESERVE", uint256(5 ether)),
            maxReserveCap: vm.envOr("FACTORY_MAX_RESERVE_CAP", uint256(12 ether)),
            graduationThreshold: vm.envOr("FACTORY_GRADUATION_THRESHOLD", uint256(10 ether)),
            feeBps: uint16(vm.envOr("FACTORY_FEE_BPS", uint256(100))),
            priceMoveAlertBps: uint16(vm.envOr("FACTORY_PRICE_MOVE_ALERT_BPS", uint256(10_000))),
            // Two minutes at 0.25 ETH a wallet — 2.5% of a 10 ETH graduation for
            // any single address, held at that fraction as the threshold moved so
            // the protection scales with the launch rather than tightening by
            // accident. Two minutes is the window a bot's edge lives in, and the
            // cap still leaves room for an ordinary opening buy. Set the window to
            // zero to turn the mechanism off.
            sniperWindowSeconds: uint16(vm.envOr("FACTORY_SNIPER_WINDOW_SECONDS", uint256(120))),
            sniperMaxEthPerWallet: vm.envOr(
                "FACTORY_SNIPER_MAX_ETH_PER_WALLET", uint256(0.25 ether)
            ),
            // Off unless a deploy names one. A migrator is the only address that
            // can ever take a launch's reserve out of the curve, and switching it
            // on ends the sell-back guarantee for every launch created afterwards
            // — see `FolioMigrator` and the note in `CurveConfig`. That is a
            // decision to make on purpose, so the default declines to make it.
            migrator: vm.envOr("FACTORY_MIGRATOR", address(0))
        });
    }
}
