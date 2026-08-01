// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";

/**
 * @title FolioScript
 * @notice Shared ground for every script in this directory: the network guard,
 *         the human confirmation gate, the deployment registry, and the
 *         formatting helpers that make CLI output readable.
 *
 * ## The network guard is the important part
 *
 * Every script here inherits {onlySupportedNetwork}, which reverts unless
 * `block.chainid` is one of the two chains in {_profile} — 84532 (Base Sepolia)
 * or 4663 (Robinhood Chain). That check runs inside the EVM, during the local
 * simulation `forge script` always performs first, so a wrong `--rpc-url` fails
 * before a single transaction is signed — let alone broadcast. It is
 * deliberately not a warning: a script pointed at a chain nobody chose should
 * not be one confirmation away from running.
 *
 * The guard is an allowlist, not a denylist. Adding a chain means adding a
 * {NetworkProfile} for it and nothing else; a chain id with no profile —
 * Ethereum, Base mainnet, an Orbit chain that is not this one — reverts with
 * {WrongNetwork}. `foundry.toml` reinforces this by resolving no alias beyond
 * these two, but the alias list only covers `--rpc-url <alias>`; this guard
 * also covers a URL someone pasted by hand.
 *
 * ## One of these chains holds real money
 *
 * Robinhood Chain (4663) is a mainnet. Its ETH was bought, the addresses in
 * `deployments/robinhood-mainnet.json` are live, and a mistake there costs
 * money rather than a faucet claim. Nothing below treats it differently — the
 * guard is about *which* chain, not how much a mistake costs — so what stands
 * between an operator and a wrong mainnet broadcast is {confirm}, which prints
 * the network and chain id and blocks on stdin. Read that banner. And keep
 * `FOLIO_SKIP_CONFIRM` for CI runs whose decision was already made in a
 * reviewed workflow file, which is the only place it appears.
 *
 * ## Everything chain-shaped lives in one place
 *
 * The deployment record, the explorer, the banner label and the RPC alias all
 * differ between the two networks, so they are read from {_profile} rather
 * than being constants. That is what lets one `DeployFactory` serve both
 * chains: there is no per-chain script, only a per-chain row.
 *
 * ## Confirmation
 *
 * {confirm} prints what is about to happen and blocks on stdin until the
 * operator types `yes`. Set `FOLIO_SKIP_CONFIRM=true` to bypass it — intended
 * for a CI run that has already made the decision, and for nothing else. The
 * bypass is loud: it prints that it was used.
 *
 * ## Keys
 *
 * The deployer key is read from the `DEPLOYER_PRIVATE_KEY` environment
 * variable, never from a literal in any file here. `.env` is already gitignored
 * and `.env.example` carries the placeholder.
 */
abstract contract FolioScript is Script {
    using stdJson for string;

    /// @notice Base Sepolia. The chain the factory at
    ///         `deployments/base-sepolia.json` lives on.
    uint256 internal constant BASE_SEPOLIA = 84532;

    /// @notice Robinhood Chain mainnet — an Arbitrum Orbit L2, EVM-equivalent
    ///         for everything these contracts do. Real ETH.
    uint256 internal constant ROBINHOOD_MAINNET = 4663;

    /**
     * @notice Everything about a network that a script needs to know.
     * @param name    What the confirmation banner calls it.
     * @param slug    Doubles as the `foundry.toml` RPC alias and as the
     *                `deployments/<slug>.json` stem, so the two can never drift
     *                apart.
     * @param explorer Explorer origin, no trailing slash. Used only for links.
     * @param blockscout Whether `explorer` is a Blockscout instance. Blockscout
     *                and Etherscan agree on `/address/<addr>` and disagree
     *                about everything else, which is what {tokenLink} needs it
     *                for.
     */
    struct NetworkProfile {
        string name;
        string slug;
        string explorer;
        bool blockscout;
    }

    /// @notice The script was pointed at a chain with no {NetworkProfile}.
    error WrongNetwork(uint256 actual);
    /// @notice The operator answered the confirmation prompt with something
    ///         other than `yes`.
    error Aborted();
    /// @notice No deployment record exists yet — run `DeployFactory` first.
    error NoDeployment();

    /**
     * @dev Refuses to run on any chain without a {NetworkProfile}.
     *
     *      Placed on `run()` in every script rather than checked once in a
     *      constructor, because a script's constructor runs before `--rpc-url`
     *      is applied and would therefore see the wrong chain id.
     */
    modifier onlySupportedNetwork() {
        _profile(); // Reverts with WrongNetwork if the chain id is not allowed.
        _;
    }

    // -----------------------------------------------------------------------
    // Networks
    // -----------------------------------------------------------------------

    /**
     * @dev The profile for the chain the script is running against.
     *
     *      Two chains, and deliberately no third. Base Sepolia is where the
     *      rehearsal happens and its ETH is free; Robinhood Chain is the
     *      mainnet Folio launches on, where it is not. Prove a change on
     *      84532 before pointing anything at 4663 — that ordering is the
     *      reason the testnet row is still here at all.
     */
    function _profile() internal view returns (NetworkProfile memory) {
        if (block.chainid == BASE_SEPOLIA) {
            return NetworkProfile({
                name: "Base Sepolia (testnet)",
                slug: "base-sepolia",
                explorer: "https://sepolia.basescan.org",
                blockscout: false
            });
        }
        if (block.chainid == ROBINHOOD_MAINNET) {
            return NetworkProfile({
                name: "Robinhood Chain (MAINNET - real funds)",
                slug: "robinhood-mainnet",
                // Blockscout, not an Etherscan deployment — which is also why
                // `--verify` needs `--verifier blockscout`. See DEPLOYMENT.md.
                explorer: "https://robinhoodchain.blockscout.com",
                blockscout: true
            });
        }
        revert WrongNetwork(block.chainid);
    }

    /// @dev The name the banner prints, e.g. `Base Sepolia (testnet)`.
    function networkName() internal view returns (string memory) {
        return _profile().name;
    }

    /// @dev The `--rpc-url` alias for this chain, for printed next steps.
    function networkSlug() internal view returns (string memory) {
        return _profile().slug;
    }

    /**
     * @dev Where the deploy script records what it deployed, and where every
     *      other script reads the factory address back from.
     *
     *      One file per chain, named after the slug. A deploy to Robinhood
     *      therefore cannot overwrite the Base Sepolia record, and pointing a
     *      trading script at the wrong chain finds no factory rather than the
     *      wrong one. `foundry.toml` grants read-write on `./deployments`, so
     *      every path this returns is already permitted.
     */
    function deploymentsPath() internal view returns (string memory) {
        return string.concat("./deployments/", _profile().slug, ".json");
    }

    // -----------------------------------------------------------------------
    // Confirmation
    // -----------------------------------------------------------------------

    /**
     * @dev Prints the network banner, then blocks until the operator types
     *      `yes`. Anything else aborts before any broadcast.
     * @param action One line describing what is about to be signed.
     */
    function confirm(string memory action) internal {
        console2.log("");
        console2.log(
            unicode"─────────────────────────────────────────────────────"
        );
        console2.log("  Network      : %s", networkName());
        console2.log("  Chain ID     : %s", vm.toString(block.chainid));
        console2.log("  Deployer     : %s", vm.toString(deployer()));
        console2.log("  Balance      : %s ETH", formatEth(deployer().balance));
        console2.log("  About to     : %s", action);
        console2.log(
            unicode"─────────────────────────────────────────────────────"
        );

        if (vm.envOr("FOLIO_SKIP_CONFIRM", false)) {
            console2.log("  FOLIO_SKIP_CONFIRM=true -> proceeding without asking.");
            console2.log("");
            return;
        }

        string memory answer = vm.prompt("  Type 'yes' to continue");
        if (keccak256(bytes(answer)) != keccak256(bytes("yes"))) {
            console2.log("  Aborted - nothing was broadcast.");
            revert Aborted();
        }
        console2.log("");
    }

    // -----------------------------------------------------------------------
    // Keys
    // -----------------------------------------------------------------------

    /// @dev The deployer's private key, from the environment. Never hardcoded.
    function deployerKey() internal view returns (uint256) {
        return vm.envUint("DEPLOYER_PRIVATE_KEY");
    }

    /// @dev The address behind {deployerKey}.
    function deployer() internal view returns (address) {
        return vm.addr(deployerKey());
    }

    // -----------------------------------------------------------------------
    // Deployment registry
    // -----------------------------------------------------------------------

    /**
     * @dev The factory recorded by the last deploy.
     *
     *      Reading it from disk rather than from an env var is what keeps the
     *      address out of every command line, and keeps the frontend and these
     *      scripts pointed at the same contract by construction.
     */
    function loadFactory() internal view returns (FolioFactory) {
        string memory path = deploymentsPath();
        if (!vm.exists(path)) revert NoDeployment();
        string memory json = vm.readFile(path);
        address factory = recordedAddress(json, ".factory");
        if (factory == address(0)) revert NoDeployment();
        return FolioFactory(factory);
    }

    /**
     * @dev An address field out of a deployment record, or the zero address
     *      when the record does not carry one yet.
     *
     *      A record is committed for a chain before anything is deployed to it,
     *      with every address field an empty string — that is what makes the
     *      file's shape reviewable in a diff before the first deploy. Empty is
     *      therefore a normal state, not a corrupt one, but `readAddress` does
     *      not see it that way: it hands `""` to the address parser and the
     *      script dies with a parser error, several layers below anything that
     *      could explain itself. Reading the field as the string it is and
     *      converting only a non-empty one keeps "nothing recorded yet" a value
     *      the callers above can act on.
     */
    function recordedAddress(string memory json, string memory key)
        internal
        view
        returns (address)
    {
        if (!json.keyExists(key)) return address(0);
        string memory raw = json.readString(key);
        if (bytes(raw).length == 0) return address(0);
        return vm.parseAddress(raw);
    }

    /**
     * @dev The token a script should act on: `FOLIO_TOKEN` when set, otherwise
     *      the most recent launch recorded by `CreateToken`.
     */
    function loadToken() internal view returns (FolioToken) {
        (FolioToken token, bool found) = tryLoadToken();
        if (!found) revert NoDeployment();
        return token;
    }

    /**
     * @dev {loadToken}, but reporting absence instead of reverting.
     *
     *      The pause scripts need to carry on when no launch has been recorded
     *      yet — halting the platform is worth doing whether or not there is
     *      something to verify against afterwards. Catching a revert would mean
     *      `try this.loadToken()`, and `this` compiles to the `ADDRESS` opcode,
     *      which `forge script` rejects outright: script contracts are
     *      ephemeral and nothing may depend on their address.
     */
    function tryLoadToken() internal view returns (FolioToken token, bool found) {
        address fromEnv = vm.envOr("FOLIO_TOKEN", address(0));
        if (fromEnv != address(0)) return (FolioToken(fromEnv), true);

        string memory path = deploymentsPath();
        if (!vm.exists(path)) return (FolioToken(address(0)), false);
        string memory json = vm.readFile(path);

        address last = recordedAddress(json, ".lastToken");
        if (last == address(0)) return (FolioToken(address(0)), false);
        return (FolioToken(last), true);
    }

    // -----------------------------------------------------------------------
    // Formatting
    //
    // These exist so the scripts print numbers an operator can actually read.
    // A reserve of 1250000000000000000 wei tells you nothing at a glance;
    // "1.25 ETH" does.
    // -----------------------------------------------------------------------

    /// @dev Wei as a fixed 6-decimal ETH string, e.g. `1.250000`.
    function formatEth(uint256 weiAmount) internal pure returns (string memory) {
        return formatUnits(weiAmount, 18, 6);
    }

    /**
     * @dev Wei as a fixed 12-decimal ETH string, for the marginal price.
     *
     *      A launch opens around 2e12 wei per token — 0.000002 ETH — so at the
     *      6 decimals {formatEth} uses, the before/after prices of a trade
     *      round to the same string and the move disappears. Twelve decimals
     *      is enough to show it.
     */
    function formatPrice(uint256 weiAmount) internal pure returns (string memory) {
        return formatUnits(weiAmount, 18, 12);
    }

    /// @dev Token units as a fixed 6-decimal string of whole tokens.
    function formatTokens(uint256 units) internal pure returns (string memory) {
        return formatUnits(units, 18, 6);
    }

    /**
     * @dev Renders a fixed-point value as a decimal string.
     * @param value The raw integer.
     * @param decimals How many decimals `value` carries.
     * @param shown How many decimal places to print; the rest are truncated.
     */
    function formatUnits(uint256 value, uint256 decimals, uint256 shown)
        internal
        pure
        returns (string memory)
    {
        uint256 scale = 10 ** decimals;
        uint256 whole = value / scale;
        uint256 frac = ((value % scale) * (10 ** shown)) / scale;

        bytes memory fracDigits = bytes(uintToString(frac));
        bytes memory padded = new bytes(shown);
        uint256 pad = shown - fracDigits.length;
        for (uint256 i = 0; i < shown; i++) {
            padded[i] = i < pad ? bytes1("0") : fracDigits[i - pad];
        }
        return string.concat(uintToString(whole), ".", string(padded));
    }

    /// @dev Basis points as a percentage string, e.g. `100` -> `1.00%`.
    function formatBps(uint256 bps) internal pure returns (string memory) {
        return string.concat(formatUnits(bps, 2, 2), "%");
    }

    function uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) {
            digits++;
        }
        bytes memory buf = new bytes(digits);
        for (uint256 v = value; v != 0; v /= 10) {
            buf[--digits] = bytes1(uint8(48 + (v % 10)));
        }
        return string(buf);
    }

    // -----------------------------------------------------------------------
    // Links
    // -----------------------------------------------------------------------

    /// @dev An explorer address link for `who`. Both explorers use this path.
    function addressLink(address who) internal view returns (string memory) {
        return string.concat(_profile().explorer, "/address/", vm.toString(who));
    }

    /**
     * @dev A link to `holder`'s balance of `token`.
     *
     *      The two explorers disagree here. Etherscan puts a holder's balance
     *      on the token page behind `?a=`; Blockscout has no such view, and
     *      shows a holder's balances on the address page's token tab instead.
     *      Same destination, two routes — so this picks by profile rather than
     *      emitting one URL that 404s on half the deployments.
     */
    function tokenLink(address token, address holder) internal view returns (string memory) {
        NetworkProfile memory net = _profile();
        if (net.blockscout) {
            return string.concat(net.explorer, "/address/", vm.toString(holder), "?tab=tokens");
        }
        return
            string.concat(net.explorer, "/token/", vm.toString(token), "?a=", vm.toString(holder));
    }

    /// @dev The rule for every script's output: one blank line, a titled bar.
    function header(string memory title) internal pure {
        console2.log("");
        console2.log(unicode"═══ %s ═══", title);
        console2.log("");
    }
}
