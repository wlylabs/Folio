// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
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
 * The owner is the platform, and its power is bounded in code, not by convention.
 * There are exactly three privileged functions and this is all of them:
 *
 * - {setDefaultConfig} changes the terms offered to *future* launches. Every token
 *   snapshots the config at creation, so live launches are untouchable. The setter
 *   is also fenced by hard constants below — even the owner cannot set a fee above
 *   `MAX_FEE_BPS` or a cap above `MAX_RESERVE_CAP`.
 * - {pause} halts new launches and, because tokens read `paused()` from here,
 *   halts buying and selling on every launch. Read that plainly: it is a
 *   break-glass switch that stops holders selling too. It exists so a curve bug
 *   found post-deploy can be contained rather than drained, and it is the reason
 *   the per-launch `maxReserveCap` exists as well — to bound what a bug can reach
 *   before anyone notices. It does not reach `claimFees`, and it does not stop a
 *   single view function anywhere in the system: a paused Folio is a Folio you can
 *   still read in full.
 * - {unpause} releases it.
 *
 * Nothing here can move a token's reserve, mint supply, reassign a creator, block a
 * creator from claiming fees, or alter a live launch's terms. In particular there is
 * deliberately **no per-launch cap setter**: being able to retune a live market's
 * ceiling is a lever over people's open positions, and it would buy nothing that
 * {pause} does not already cover.
 *
 * ## What a creator may choose, and which way it points
 *
 * Two of the platform's terms are a floor rather than a fixture, and a creator may
 * move either of them at creation — in one direction only:
 *
 * - **`maxReserveCap`** may be *lowered*, tightening the blast radius of the launch
 *   the creator is taking the risk on.
 * - **The opening window** may be *lengthened*, and its per-wallet cap *lowered*.
 *   Both give the creator's buyers more protection from snipers than the platform
 *   requires.
 *
 * The pattern is the same in both cases and worth stating once: an argument to
 * {createToken} can only ever make a launch safer than the platform default, never
 * riskier. That is what lets the default be read as a guarantee about every launch
 * on the platform, instead of a starting point somebody might have negotiated away.
 * A creator who wants neither choice passes zero and inherits the default.
 *
 * ## Ownership cannot be lost, only handed over
 *
 * Transfer is two-step, so a typo cannot orphan the switch — the recipient has to
 * call {acceptOwnership} from the address in question, which proves it can
 * transact. {renounceOwnership} is disabled on top of that, because the one thing
 * it can accomplish is destroying the emergency stop forever, by accident, in one
 * transaction. Together those two mean the owner seat can only ever move to an
 * address that has demonstrated it holds the keys.
 */
contract FolioFactory is Ownable2Step, Pausable, ReentrancyGuard {
    // -----------------------------------------------------------------------
    // Hard limits — these bound the owner as much as the caller
    // -----------------------------------------------------------------------

    /// @notice Ceiling on the per-leg fee, in basis points (5%).
    uint16 public constant MAX_FEE_BPS = 500;
    /// @notice Ceiling on a launch's real-ETH reserve cap.
    uint256 public constant MAX_RESERVE_CAP = 1_000_000 ether;
    /// @notice Floor on a creator-chosen reserve cap. Below this a launch could not
    ///         take in enough ETH to trade meaningfully before closing itself.
    uint256 public constant MIN_RESERVE_CAP = 0.001 ether;
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
    /// @notice Floor on a non-zero `priceMoveAlertBps`. A threshold below this would
    ///         fire on essentially every trade, which is not a signal.
    uint16 public constant MIN_PRICE_MOVE_ALERT_BPS = 100;
    /// @notice Ceiling on the opening-window length, in seconds.
    /// @dev The window exists to cover the minutes a launch is being discovered,
    ///      not to ration it. An hour is already far past the point where a cap
    ///      stops deterring bots and starts being the reason humans cannot buy.
    uint16 public constant MAX_SNIPER_WINDOW_SECONDS = 1 hours;
    /// @notice Floor on the per-wallet opening cap when a window is configured.
    /// @dev Guards the pairing that would otherwise be legal and useless: a live
    ///      window with a cap so small no buy clears it, which is a launch nobody
    ///      can enter until the window expires.
    uint256 public constant MIN_SNIPER_MAX_ETH_PER_WALLET = 0.0001 ether;

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
     * @param config The curve terms this launch is frozen to — the *effective*
     *        terms, after any creator-chosen cap and the threshold clamp that
     *        follows from it, not the platform default they were derived from.
     */
    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupply,
        CurveConfig config
    );

    /**
     * @notice The default curve terms for future launches changed.
     * @dev Carries `by` and `timestamp` so the audit trail for the one adjustable
     *      platform parameter is self-contained, rather than something you have to
     *      reconstruct by joining logs against block metadata.
     * @param by Who changed it.
     * @param config The new default terms.
     * @param timestamp Block timestamp of the change.
     */
    event DefaultConfigUpdated(address indexed by, CurveConfig config, uint256 timestamp);

    /**
     * @notice The emergency stop was engaged. Trading is halted on every launch.
     * @dev OpenZeppelin's `Pausable` emits its own `Paused(address)` alongside
     *      this. That one exists for tooling that already knows the standard;
     *      this one is the platform's own audit record and carries the timestamp.
     * @param by Who engaged it.
     * @param timestamp Block timestamp of the pause.
     */
    event EmergencyPaused(address indexed by, uint256 timestamp);

    /**
     * @notice The emergency stop was released.
     * @param by Who released it.
     * @param timestamp Block timestamp of the unpause.
     */
    event EmergencyUnpaused(address indexed by, uint256 timestamp);

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
    error InvalidReserveCap();
    error InvalidGraduationThreshold();
    error InvalidPriceMoveAlert();
    /// @notice An opening window longer than `MAX_SNIPER_WINDOW_SECONDS`.
    error InvalidSniperWindow();
    /// @notice A live opening window paired with a per-wallet cap below
    ///         `MIN_SNIPER_MAX_ETH_PER_WALLET`.
    error InvalidSniperCap();
    error SupplyTooLargeForCurve();
    /// @notice A creator-chosen cap below `MIN_RESERVE_CAP`.
    error ReserveCapTooLow();
    /// @notice A creator-chosen cap above the platform's current default. The cap
    ///         may only ever be tightened, never loosened.
    error ReserveCapAboveDefault();
    /// @notice A creator-chosen opening window shorter than the platform default.
    ///         Protection may be added to a launch, never taken off it.
    error SniperWindowBelowDefault();
    /// @notice A creator-chosen per-wallet opening cap above the platform default.
    ///         A higher cap is less protection, so it goes the forbidden way.
    error SniperCapAboveDefault();
    /// @notice {renounceOwnership} is disabled. See the note on ownership above.
    error RenounceDisabled();

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
        emit DefaultConfigUpdated(msg.sender, config, block.timestamp);
    }

    // -----------------------------------------------------------------------
    // Launching
    // -----------------------------------------------------------------------

    /**
     * @notice Launch a token on the platform's default terms.
     * @dev Equivalent to the four-argument overload with `maxReserveCap` zero.
     * @param name_ ERC20 name, 1 to `MAX_NAME_LENGTH` bytes.
     * @param symbol_ ERC20 symbol, 1 to `MAX_SYMBOL_LENGTH` bytes.
     * @param wholeSupply Total supply in whole tokens, 1 to `MAX_WHOLE_SUPPLY`.
     * @return token Address of the new launch.
     */
    function createToken(string calldata name_, string calldata symbol_, uint256 wholeSupply)
        external
        returns (address token)
    {
        return _createToken(name_, symbol_, wholeSupply, 0, 0, 0);
    }

    /**
     * @notice Launch a token, choosing how much ETH its curve may ever hold.
     *
     * The cap is this launch's blast radius. It is the maximum real ETH that can
     * ever sit in the reserve, and therefore the most that a curve bug nobody has
     * found yet could put at risk in this one launch. A creator who wants a smaller
     * number than the platform default is free to pick one; the reverse is refused,
     * so the platform's ceiling always binds.
     *
     * Once the reserve reaches the cap the curve is closed to buys. A buy that
     * would overshoot is **not** rejected — it fills the reserve to exactly the cap
     * and the unused ETH is sent straight back to the buyer. Rejecting instead
     * would mean only an exactly-sized trade could ever land a launch on its own
     * ceiling, so every near-cap buy would race and most would fail; the refund
     * path makes the landing deterministic. Either way the invariant is the same
     * one: `ethReserve` never exceeds `maxReserveCap`.
     *
     * @param name_ ERC20 name, 1 to `MAX_NAME_LENGTH` bytes.
     * @param symbol_ ERC20 symbol, 1 to `MAX_SYMBOL_LENGTH` bytes.
     * @param wholeSupply Total supply in whole tokens, 1 to `MAX_WHOLE_SUPPLY`.
     *        18 decimals are added by the token. The whole supply becomes curve
     *        inventory; none of it is pre-allocated to the creator.
     * @param maxReserveCap Ceiling on real ETH this launch's reserve may hold, in
     *        wei. Zero means "use the platform default". Otherwise it must be at
     *        least `MIN_RESERVE_CAP` and no more than the current default cap. If
     *        it lands below the default graduation threshold, the threshold is
     *        clamped down to it — a launch cannot be asked to graduate at a number
     *        its own reserve is forbidden to reach.
     * @return token Address of the new launch.
     */
    function createToken(
        string calldata name_,
        string calldata symbol_,
        uint256 wholeSupply,
        uint256 maxReserveCap
    ) external returns (address token) {
        return _createToken(name_, symbol_, wholeSupply, maxReserveCap, 0, 0);
    }

    /**
     * @notice Launch a token, choosing the reserve cap *and* the terms of the
     *         opening window.
     *
     * Same bargain as the cap, pointed at the other risk. A creator may hand
     * their buyers more protection than the platform requires — a longer window,
     * a smaller per-wallet bite — and may not hand them less. There is no
     * argument to this function that makes a launch easier to snipe than the
     * platform default, which is what makes the default a floor rather than a
     * suggestion.
     *
     * A creator whose platform has the mechanism switched off entirely can still
     * switch it on for their own launch: with no default cap to be under, they
     * name one outright. The reverse is closed — nothing here reaches zero.
     *
     * @param name_ ERC20 name, 1 to `MAX_NAME_LENGTH` bytes.
     * @param symbol_ ERC20 symbol, 1 to `MAX_SYMBOL_LENGTH` bytes.
     * @param wholeSupply Total supply in whole tokens, 1 to `MAX_WHOLE_SUPPLY`.
     * @param maxReserveCap Ceiling on real ETH, in wei. Zero means the platform
     *        default; see the four-argument overload for the rest of the rules.
     * @param sniperWindowSeconds How long the per-wallet buy cap should apply
     *        for, in seconds. Zero means the platform default. Otherwise it must
     *        be at least the default — the window can be lengthened, never cut —
     *        and no more than `MAX_SNIPER_WINDOW_SECONDS`.
     * @param sniperMaxEthPerWallet What one address may spend during that window,
     *        in wei. Zero means the platform default. Otherwise it must be no more
     *        than the default when the platform has one, and at least
     *        `MIN_SNIPER_MAX_ETH_PER_WALLET` either way.
     * @return token Address of the new launch.
     */
    function createToken(
        string calldata name_,
        string calldata symbol_,
        uint256 wholeSupply,
        uint256 maxReserveCap,
        uint16 sniperWindowSeconds,
        uint256 sniperMaxEthPerWallet
    ) external returns (address token) {
        return _createToken(
            name_, symbol_, wholeSupply, maxReserveCap, sniperWindowSeconds, sniperMaxEthPerWallet
        );
    }

    // -----------------------------------------------------------------------
    // Owner controls
    // -----------------------------------------------------------------------

    /**
     * @notice Set the curve terms future launches will use.
     * @dev Cannot reach launches that already exist — each one holds its own copy.
     *      Lowering the default cap here also lowers the ceiling a creator may
     *      choose from, since {createToken} validates against the live default.
     * @param config The new default terms.
     */
    function setDefaultConfig(CurveConfig calldata config) external onlyOwner {
        _validateConfig(config);
        defaultConfig = config;
        emit DefaultConfigUpdated(msg.sender, config, block.timestamp);
    }

    /**
     * @notice Engage the emergency stop: no new launches, and no buying or selling
     *         on any existing launch.
     * @dev Intended for a curve bug found after deploy. It does not block
     *      `claimFees`, it does not block any view function, and it cannot move
     *      anyone's funds.
     */
    function pause() external onlyOwner {
        _pause();
        emit EmergencyPaused(msg.sender, block.timestamp);
    }

    /// @notice Release the emergency stop, resuming launches and trading.
    function unpause() external onlyOwner {
        _unpause();
        emit EmergencyUnpaused(msg.sender, block.timestamp);
    }

    /**
     * @notice Disabled. Ownership can be handed over with {transferOwnership} plus
     *         {acceptOwnership}, and cannot be given up.
     * @dev Renouncing would permanently destroy the emergency stop and the config
     *      setter in a single transaction, with no way back and nothing gained. It
     *      is the one irreversible mistake left on this contract, so it is closed
     *      to everyone, the owner included.
     */
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /**
     * @dev Shared body of both {createToken} overloads.
     *
     *      The clone is registered before it is initialized, so the external call
     *      that finishes setup is the last thing this function does. That call goes
     *      to a proxy created here over an implementation fixed at construction, so
     *      it has no way to call back — the ordering and the `nonReentrant` guard
     *      are kept anyway, because relying on the callee's good behaviour is how
     *      reentrancy bugs get written, and because a later change to `initialize`
     *      should not silently become a reentrancy bug.
     */
    function _createToken(
        string calldata name_,
        string calldata symbol_,
        uint256 wholeSupply,
        uint256 maxReserveCap,
        uint16 sniperWindowSeconds,
        uint256 sniperMaxEthPerWallet
    ) private whenNotPaused nonReentrant returns (address token) {
        uint256 nameLength = bytes(name_).length;
        uint256 symbolLength = bytes(symbol_).length;
        if (nameLength == 0) revert EmptyName();
        if (symbolLength == 0) revert EmptySymbol();
        if (nameLength > MAX_NAME_LENGTH) revert NameTooLong();
        if (symbolLength > MAX_SYMBOL_LENGTH) revert SymbolTooLong();
        if (wholeSupply == 0 || wholeSupply > MAX_WHOLE_SUPPLY) revert InvalidSupply();

        CurveConfig memory config = defaultConfig;

        // A creator may tighten their own blast radius, never widen it. The
        // platform default is the ceiling, so lowering the default here later also
        // lowers what any future creator may ask for.
        if (maxReserveCap != 0) {
            if (maxReserveCap < MIN_RESERVE_CAP) revert ReserveCapTooLow();
            if (maxReserveCap > config.maxReserveCap) revert ReserveCapAboveDefault();
            config.maxReserveCap = maxReserveCap;
            // A threshold above the cap is unreachable, and the token rejects that
            // combination outright. Clamping is the useful reading of a small cap:
            // the launch graduates when it fills up.
            if (config.graduationThreshold > maxReserveCap) {
                config.graduationThreshold = maxReserveCap;
            }
        }

        // The opening window moves the same way and for the same reason: a
        // creator may give their buyers more protection than the platform asks
        // for, never less. Lengthening the window and lowering the per-wallet
        // bite are both "more", so those are the only directions open.
        if (sniperWindowSeconds != 0) {
            if (sniperWindowSeconds < config.sniperWindowSeconds) {
                revert SniperWindowBelowDefault();
            }
            if (sniperWindowSeconds > MAX_SNIPER_WINDOW_SECONDS) revert InvalidSniperWindow();
            config.sniperWindowSeconds = sniperWindowSeconds;
        }
        if (sniperMaxEthPerWallet != 0) {
            // When the platform ships the mechanism off there is no default cap
            // to be under, so a creator switching it on for their own launch
            // names one outright rather than being refused for exceeding zero.
            if (
                config.sniperMaxEthPerWallet != 0
                    && sniperMaxEthPerWallet > config.sniperMaxEthPerWallet
            ) {
                revert SniperCapAboveDefault();
            }
            config.sniperMaxEthPerWallet = sniperMaxEthPerWallet;
        }
        // Catches the one combination the two branches above can still produce:
        // a creator who turned a window on without naming the cap it needs.
        if (
            config.sniperWindowSeconds != 0
                && config.sniperMaxEthPerWallet < MIN_SNIPER_MAX_ETH_PER_WALLET
        ) {
            revert InvalidSniperCap();
        }

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
        if (config.maxReserveCap < MIN_RESERVE_CAP || config.maxReserveCap > MAX_RESERVE_CAP) {
            revert InvalidReserveCap();
        }
        if (config.graduationThreshold > config.maxReserveCap) {
            revert InvalidGraduationThreshold();
        }
        // Zero disables the monitoring signal; anything non-zero has to be coarse
        // enough to mean something when it fires.
        if (config.priceMoveAlertBps != 0 && config.priceMoveAlertBps < MIN_PRICE_MOVE_ALERT_BPS) {
            revert InvalidPriceMoveAlert();
        }
        // Zero disables the opening-window cap, and is what every launch made
        // before the mechanism existed ran with. A live window needs a cap a real
        // buy can clear, or it is a launch that refuses everyone until it expires.
        if (config.sniperWindowSeconds > MAX_SNIPER_WINDOW_SECONDS) {
            revert InvalidSniperWindow();
        }
        if (
            config.sniperWindowSeconds != 0
                && config.sniperMaxEthPerWallet < MIN_SNIPER_MAX_ETH_PER_WALLET
        ) {
            revert InvalidSniperCap();
        }
    }
}
