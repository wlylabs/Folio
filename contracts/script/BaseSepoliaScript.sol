// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";

/**
 * @title BaseSepoliaScript
 * @notice Shared ground for every script in this directory: the network guard,
 *         the human confirmation gate, the deployment registry, and the
 *         formatting helpers that make CLI output readable.
 *
 * ## The network guard is the important part
 *
 * Every script here inherits {onlyBaseSepolia}, which reverts unless
 * `block.chainid` is 84532. That check runs inside the EVM, during the local
 * simulation `forge script` always performs first, so a wrong `--rpc-url`
 * fails before a single transaction is signed — let alone broadcast. It is
 * deliberately not a warning: a testnet script pointed at a chain where the
 * addresses hold real money should not be one confirmation away from running.
 *
 * `foundry.toml` reinforces this by naming no mainnet RPC alias at all, but the
 * alias list only covers `--rpc-url base-sepolia`; this guard also covers a URL
 * someone pasted by hand.
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
abstract contract BaseSepoliaScript is Script {
    using stdJson for string;

    /// @notice Base Sepolia. The only chain any script in this directory runs on.
    uint256 internal constant BASE_SEPOLIA = 84532;

    /// @notice Where the deploy script records what it deployed, and where every
    ///         other script reads the factory address back from.
    string internal constant DEPLOYMENTS_PATH = "./deployments/base-sepolia.json";

    /// @notice Basescan for Base Sepolia. Used only to build clickable links.
    string internal constant EXPLORER = "https://sepolia.basescan.org";

    /// @notice The script was pointed at a chain that is not Base Sepolia.
    error WrongNetwork(uint256 expected, uint256 actual);
    /// @notice The operator answered the confirmation prompt with something
    ///         other than `yes`.
    error Aborted();
    /// @notice No deployment record exists yet — run `DeployFactory` first.
    error NoDeployment();

    /**
     * @dev Refuses to run anywhere but Base Sepolia.
     *
     *      Placed on `run()` in every script rather than checked once in a
     *      constructor, because a script's constructor runs before `--rpc-url`
     *      is applied and would therefore see the wrong chain id.
     */
    modifier onlyBaseSepolia() {
        if (block.chainid != BASE_SEPOLIA) revert WrongNetwork(BASE_SEPOLIA, block.chainid);
        _;
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
        console2.log("  Network      : Base Sepolia (testnet)");
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
        if (!vm.exists(DEPLOYMENTS_PATH)) revert NoDeployment();
        string memory json = vm.readFile(DEPLOYMENTS_PATH);
        return FolioFactory(json.readAddress(".factory"));
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

        if (!vm.exists(DEPLOYMENTS_PATH)) return (FolioToken(address(0)), false);
        string memory json = vm.readFile(DEPLOYMENTS_PATH);
        if (!json.keyExists(".lastToken")) return (FolioToken(address(0)), false);

        address last = json.readAddress(".lastToken");
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

    /// @dev A Basescan address link for `who`.
    function addressLink(address who) internal pure returns (string memory) {
        return string.concat(EXPLORER, "/address/", vm.toString(who));
    }

    /// @dev A Basescan token-holdings link for `holder` on `token`.
    function tokenLink(address token, address holder) internal pure returns (string memory) {
        return string.concat(EXPLORER, "/token/", vm.toString(token), "?a=", vm.toString(holder));
    }

    /// @dev The rule for every script's output: one blank line, a titled bar.
    function header(string memory title) internal pure {
        console2.log("");
        console2.log(unicode"═══ %s ═══", title);
        console2.log("");
    }
}
