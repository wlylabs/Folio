// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20Upgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CurveConfig} from "./types/CurveConfig.sol";
import {IFolioFactory} from "./interfaces/IFolioFactory.sol";

/**
 * @title FolioToken
 * @notice An ERC20 that is also its own bonding-curve market maker. One of these
 *         is cloned per launch by `FolioFactory`.
 *
 * ## Why there is no constructor
 *
 * This contract is deployed once as an *implementation*, and every launch gets a
 * 45-byte EIP-1167 minimal proxy pointing at it (~41k gas instead of ~1.5M). A
 * proxy runs this code against its own storage, and its own constructor never
 * executes — so setup lives in {initialize}, which can only ever run once. The
 * implementation itself is locked in its constructor via `_disableInitializers`
 * so nobody can initialize the shared logic contract and squat on it.
 *
 * ## The curve
 *
 * Pricing is constant product, `x * y = k`, the same curve Uniswap uses:
 *
 *   x = virtualEthReserve + ethReserve   (ETH side, part imaginary)
 *   y = curveSupply - tokensSold         (tokens still held by the curve)
 *
 * `virtualEthReserve` is ETH that does not exist. It is there so the curve has a
 * finite opening price instead of giving the first token away for nothing, and it
 * means the opening market cap of a launch equals `virtualEthReserve` no matter
 * what supply the creator chose.
 *
 * A buy moves along the curve one way, a sell moves back along the identical
 * curve. That is the whole solvency argument: real ETH in the reserve is at every
 * moment exactly what it costs to buy back every circulating token, because both
 * legs price off the same `k`. There is no reserve-versus-liability bookkeeping
 * that could drift, and no ordering of buys and sells that leaves the last seller
 * short. Rounding is always resolved in the reserve's favour, so numerical dust
 * accumulates as a surplus rather than a shortfall.
 *
 * Fees never enter this: they are skimmed off the ETH before it reaches the
 * reserve on a buy, and off the payout the curve produced on a sell. `ethReserve`
 * is tracked in storage rather than read from `address(this).balance`, because the
 * balance also holds unclaimed fees and can be inflated by forced sends — curve
 * maths must never depend on a number an outsider can move.
 *
 * ## Privileged roles — there are exactly two, and both are narrow
 *
 * - **The creator** can call `claimFees` and nothing else. They cannot mint,
 *   pause, change the curve, or touch the reserve.
 * - **The factory owner** (the platform) holds a global emergency stop. While the
 *   factory is paused, buying and selling revert here. It cannot move funds,
 *   cannot change a live launch's terms, and cannot stop `claimFees`.
 *
 * There is no admin path to the reserve. Nothing in this contract can transfer
 * ETH anywhere except to a buyer as change, a seller as proceeds, or the creator
 * as accrued fees.
 */
contract FolioToken is ERC20Upgradeable, ReentrancyGuard {
    // OpenZeppelin v5's `ReentrancyGuard` is safe to inherit into a clone even
    // though its constructor never runs here. It keeps its flag at a fixed
    // ERC-7201 slot — so it cannot collide with the storage below — and its check
    // is `slot == ENTERED`, not `slot != NOT_ENTERED`. A clone therefore starts at
    // zero and reads as "not entered", which is correct; the slot settles at
    // `NOT_ENTERED` after the first guarded call. The transient-storage variant is
    // deliberately avoided: it needs EIP-1153, which would tie us to Cancun.

    // -----------------------------------------------------------------------
    // Storage
    //
    // Set once by {initialize} and then immutable in practice. A clone cannot use
    // Solidity `immutable`, since that bakes values into the implementation's own
    // bytecode, which every clone shares.
    // -----------------------------------------------------------------------

    /// @notice The factory that created this token. Source of the emergency stop.
    address public factory;
    /// @notice Fee per leg in basis points, copied from the factory at creation.
    uint16 public feeBps;
    /// @notice True once the curve has closed itself to buys at the threshold.
    bool public graduated;

    /// @notice Receives the trading fees. Has no other authority here.
    address public creator;

    /// @notice Imaginary ETH anchoring the curve's opening price, in wei.
    uint256 public virtualEthReserve;
    /// @notice Ceiling on real ETH this curve will accept, in wei.
    uint256 public ethCap;
    /// @notice Real ETH reserve at which buying closes, in wei. Zero disables it.
    uint256 public graduationThreshold;

    /// @notice Token units the curve started with — the entire supply.
    uint256 public curveSupply;
    /// @notice Token units bought out of the curve, net of sells. Rises on buy,
    ///         falls on sell, and is always strictly below `curveSupply`.
    uint256 public tokensSold;
    /// @notice Real ETH backing the curve, in wei. Excludes unclaimed fees, and is
    ///         never derived from `address(this).balance`.
    uint256 public ethReserve;
    /// @notice Fees earned and not yet claimed by the creator, in wei.
    uint256 public feesAccrued;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    /// @notice Emitted once, when the factory finishes setting this token up.
    event Initialized(address indexed factory, address indexed creator, uint256 supply);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ZeroAddress();
    error InvalidSupply();
    error InvalidConfig();

    /// @dev Locks the implementation contract itself. Clones are unaffected: they
    ///      have their own storage, so their initializer flag starts clear.
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice One-time setup, called by the factory in the same transaction that
     *         clones this token.
     * @dev Guarded by OpenZeppelin's `initializer`, so a second call reverts. The
     *      caller is recorded as `factory`, which is what the emergency stop is
     *      read from — a clone made outside `FolioFactory` would answer to
     *      whoever made it, which is why the factory keeps an `isFolioToken`
     *      registry for callers to check authenticity against.
     * @param creator_ Address that will receive trading fees.
     * @param name_ ERC20 name.
     * @param symbol_ ERC20 symbol.
     * @param wholeSupply Total supply in whole tokens; 18 decimals are added here.
     * @param config The curve terms, already validated by the factory.
     */
    function initialize(
        address creator_,
        string calldata name_,
        string calldata symbol_,
        uint256 wholeSupply,
        CurveConfig calldata config
    ) external initializer {
        if (creator_ == address(0)) revert ZeroAddress();
        if (wholeSupply == 0) revert InvalidSupply();
        // Re-checked rather than trusted: this function is externally reachable on
        // a clone, and a zero virtual reserve or zero cap would make the curve
        // divide by zero or refuse every buy.
        if (config.virtualEthReserve == 0 || config.ethCap == 0) revert InvalidConfig();
        if (config.graduationThreshold > config.ethCap) revert InvalidConfig();

        __ERC20_init(name_, symbol_);

        factory = msg.sender;
        creator = creator_;
        feeBps = config.feeBps;
        virtualEthReserve = config.virtualEthReserve;
        ethCap = config.ethCap;
        graduationThreshold = config.graduationThreshold;

        // The entire supply starts as curve inventory, held by this contract. It
        // is accounted for in `curveSupply`/`tokensSold` rather than by reading
        // `balanceOf(this)`, so tokens someone sends here by mistake become an
        // unreachable donation instead of corrupting the curve.
        curveSupply = wholeSupply * 10 ** decimals();
        _mint(address(this), curveSupply);

        emit Initialized(msg.sender, creator_, curveSupply);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice Token units the curve still holds and can sell.
    function curveTokenReserve() public view returns (uint256) {
        return curveSupply - tokensSold;
    }

    /**
     * @notice Marginal price of one whole token at this instant, in wei.
     * @dev `x / y`, scaled by 1e18. This is the price of an infinitesimal trade;
     *      any real trade of size pays more (buying) or less (selling) than this
     *      because it moves the curve. Use the quote functions for actual trades.
     */
    function currentPrice() public view returns (uint256) {
        return Math.mulDiv(virtualEthReserve + ethReserve, 10 ** decimals(), curveTokenReserve());
    }

    /// @notice Total market value of the supply at the marginal price, in wei.
    function marketCap() external view returns (uint256) {
        return Math.mulDiv(currentPrice(), totalSupply(), 10 ** decimals());
    }

    /// @notice Real ETH the curve can still take in before hitting whichever of
    ///         the cap or the graduation threshold binds first, in wei.
    function ethHeadroom() public view returns (uint256) {
        uint256 ceiling = ethCap;
        if (graduationThreshold != 0 && graduationThreshold < ceiling) {
            ceiling = graduationThreshold;
        }
        return ethReserve >= ceiling ? 0 : ceiling - ethReserve;
    }

    /// @notice True while the platform-wide emergency stop is engaged on the
    ///         factory. Buying and selling revert while this is true.
    function tradingPaused() public view returns (bool) {
        return IFolioFactory(factory).paused();
    }
}
