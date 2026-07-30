// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {FolioToken} from "./FolioToken.sol";
import {CurveConfig} from "./types/CurveConfig.sol";

/**
 * @title FolioFactory
 * @notice Deploys Folio launches as EIP-1167 minimal proxies, holds the platform's
 *         default curve terms, and owns the one emergency stop in the system.
 *
 * ## Why proxies
 *
 * The previous design deployed a full ERC20 per launch, about 1.5M gas of
 * bytecode every time. Here the bytecode is deployed once, as `implementation`,
 * and each launch is a 45-byte proxy that forwards every call to it via
 * `delegatecall` while keeping its own storage — roughly 41k gas. The trade-off is
 * that each later `buy`/`sell` pays about 2.6k gas extra for the forwarding hop,
 * which is a rounding error next to what the deploy saves.
 *
 * The implementation is deployed by this contract's own constructor, so a factory
 * can never be pointed at a foreign or tampered implementation.
 *
 * ## What the owner can and cannot do
 *
 * The owner is the platform, and its power is bounded in code, not by convention:
 *
 * - {setDefaultConfig} changes the terms offered to *future* launches. Every token
 *   snapshots the config at creation, so live launches are untouchable. The setter
 *   is also fenced by hard constants below — even the owner cannot set a fee above
 *   `MAX_FEE_BPS` or a cap above `MAX_ETH_CAP`.
 * - {pause} halts new launches and, because tokens read `paused()` from here,
 *   halts buying and selling on every launch. Read that plainly: it is a
 *   break-glass switch that stops holders selling too. It exists so a curve bug
 *   found post-deploy can be contained rather than drained, and it is the reason
 *   the per-launch `ethCap` exists as well — to bound what a bug can reach before
 *   anyone notices.
 * - Nothing here can move a token's reserve, mint supply, reassign a creator, or
 *   block a creator from claiming fees. There is no other privileged function.
 *
 * Ownership transfer is two-step, so a typo in an address cannot orphan the
 * switch.
 */
contract FolioFactory is Ownable2Step, Pausable {
    // -----------------------------------------------------------------------
    // Hard limits — these bound the owner as much as the caller
    // -----------------------------------------------------------------------

    /// @notice Ceiling on the per-leg fee, in basis points (5%).
    uint16 public constant MAX_FEE_BPS = 500;
    /// @notice Ceiling on a launch's real-ETH cap.
    uint256 public constant MAX_ETH_CAP = 1_000_000 ether;
    /// @notice Floor on the virtual reserve, so the opening price is meaningful.
    uint256 public constant MIN_VIRTUAL_ETH_RESERVE = 0.000001 ether;
    /// @notice Ceiling on the virtual reserve, keeping curve products far below
    ///         2^256 for any admissible supply.
    uint256 public constant MAX_VIRTUAL_ETH_RESERVE = 1_000_000 ether;
    /// @notice Ceiling on total supply, in whole tokens.
    uint256 public constant MAX_WHOLE_SUPPLY = 1e15;
    /// @notice Ceiling on the ERC20 name length, in bytes.
    uint256 public constant MAX_NAME_LENGTH = 64;
    /// @notice Ceiling on the ERC20 symbol length, in bytes.
    uint256 public constant MAX_SYMBOL_LENGTH = 16;

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    /// @notice The shared `FolioToken` logic every launch delegates to.
    address public immutable implementation;

    /// @notice Curve terms handed to the next launch. Copied, not referenced.
    CurveConfig public defaultConfig;

    /// @notice True for tokens this factory created. The way to tell a genuine
    ///         Folio launch from a clone somebody made of the implementation
    ///         behind the platform's back.
    mapping(address => bool) public isFolioToken;

    /// @notice How many launches this factory has created.
    uint256 public tokenCount;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /**
     * @notice A launch was created.
     * @param token The new token's address.
     * @param creator Who launched it, and who earns its fees.
     * @param name ERC20 name.
     * @param symbol ERC20 symbol.
     * @param totalSupply Supply in token units, 18 decimals included.
     * @param config The curve terms this launch is frozen to.
     */
    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupply,
        CurveConfig config
    );

    /// @notice The default curve terms for future launches changed.
    event DefaultConfigUpdated(CurveConfig config);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error EmptyName();
    error EmptySymbol();
    error NameTooLong();
    error SymbolTooLong();
    error InvalidSupply();
    error FeeTooHigh();
    error InvalidVirtualReserve();
    error InvalidEthCap();
    error InvalidGraduationThreshold();
    error SupplyTooLargeForCurve();

    /**
     * @notice Deploys the factory and, with it, the one shared token implementation.
     * @param initialOwner Holder of the emergency stop and the config setter.
     * @param config Starting curve terms; validated on the same rules as
     *        {setDefaultConfig}, so a bad deployment argument reverts here rather
     *        than shipping a broken default.
     */
    constructor(address initialOwner, CurveConfig memory config) Ownable(initialOwner) {
        _validateConfig(config);
        defaultConfig = config;
        implementation = address(new FolioToken());
        emit DefaultConfigUpdated(config);
    }

    // -----------------------------------------------------------------------
    // Launching
    // -----------------------------------------------------------------------

    /**
     * @notice Launch a token: clone the implementation and start its curve.
     * @dev The clone is registered before it is initialized, so the external call
     *      that finishes setup is the last thing this function does. That call
     *      goes to a proxy this function just created over an implementation fixed
     *      at construction, so it cannot re-enter anything unexpected — the
     *      ordering is kept regardless, because relying on the callee's good
     *      behaviour is how reentrancy bugs get written.
     * @param name_ ERC20 name, 1 to `MAX_NAME_LENGTH` bytes.
     * @param symbol_ ERC20 symbol, 1 to `MAX_SYMBOL_LENGTH` bytes.
     * @param wholeSupply Total supply in whole tokens, 1 to `MAX_WHOLE_SUPPLY`.
     *        18 decimals are added by the token. The whole supply becomes curve
     *        inventory; none of it is pre-allocated to the creator.
     * @return token Address of the new launch.
     */
    function createToken(string calldata name_, string calldata symbol_, uint256 wholeSupply)
        external
        whenNotPaused
        returns (address token)
    {
        uint256 nameLength = bytes(name_).length;
        uint256 symbolLength = bytes(symbol_).length;
        if (nameLength == 0) revert EmptyName();
        if (symbolLength == 0) revert EmptySymbol();
        if (nameLength > MAX_NAME_LENGTH) revert NameTooLong();
        if (symbolLength > MAX_SYMBOL_LENGTH) revert SymbolTooLong();
        if (wholeSupply == 0 || wholeSupply > MAX_WHOLE_SUPPLY) revert InvalidSupply();

        CurveConfig memory config = defaultConfig;

        // The opening price in wei per whole token is `virtualEthReserve /
        // wholeSupply`. Below one wei it floors to zero, which would hand out the
        // first tokens for free, so the supply a launch may ask for is bounded by
        // the virtual reserve backing it.
        if (config.virtualEthReserve < wholeSupply) revert SupplyTooLargeForCurve();

        token = Clones.clone(implementation);
        isFolioToken[token] = true;
        tokenCount++;

        uint256 supplyUnits = wholeSupply * 1e18;
        emit TokenCreated(token, msg.sender, name_, symbol_, supplyUnits, config);

        FolioToken(token).initialize(msg.sender, name_, symbol_, wholeSupply, config);
    }

    // -----------------------------------------------------------------------
    // Owner controls
    // -----------------------------------------------------------------------

    /**
     * @notice Set the curve terms future launches will use.
     * @dev Cannot reach launches that already exist — each one holds its own copy.
     * @param config The new default terms.
     */
    function setDefaultConfig(CurveConfig calldata config) external onlyOwner {
        _validateConfig(config);
        defaultConfig = config;
        emit DefaultConfigUpdated(config);
    }

    /**
     * @notice Engage the emergency stop: no new launches, and no buying or selling
     *         on any existing launch.
     * @dev Intended for a curve bug found after deploy. It does not block
     *      `claimFees`, and it cannot move anyone's funds.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Release the emergency stop, resuming launches and trading.
    function unpause() external onlyOwner {
        _unpause();
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /// @dev Shared by the constructor and the setter so both paths enforce the
    ///      same bounds.
    function _validateConfig(CurveConfig memory config) private pure {
        if (config.feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (
            config.virtualEthReserve < MIN_VIRTUAL_ETH_RESERVE
                || config.virtualEthReserve > MAX_VIRTUAL_ETH_RESERVE
        ) {
            revert InvalidVirtualReserve();
        }
        if (config.ethCap == 0 || config.ethCap > MAX_ETH_CAP) revert InvalidEthCap();
        if (config.graduationThreshold > config.ethCap) revert InvalidGraduationThreshold();
    }
}
