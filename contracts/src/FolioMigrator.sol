// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {FolioToken} from "./FolioToken.sol";
import {IFolioFactory} from "./interfaces/IFolioFactory.sol";

/**
 * @title FolioMigrator
 * @notice Moves a graduated launch off its bonding curve and into a permanently
 *         locked full-range Uniswap v4 position.
 *
 * ## What this is for
 *
 * A Folio curve closes to buys at graduation and never reopens. From that moment
 * the only transaction left on it is a sell, so the price can only fall, and every
 * holder knows it — which makes the threshold a countdown rather than a milestone.
 * This contract is the exit from that: it takes the reserve and pairs it against
 * newly minted tokens in a pool that keeps trading in both directions forever.
 *
 * ## What it costs, stated plainly
 *
 * Migration ends the sell-back guarantee. On the curve, selling every circulating
 * token back returns exactly the reserve — an identity, not an approximation. In a
 * pool it does not: an AMM position holds both sides at every price, so some of the
 * ETH is never reachable by sellers. At the shipped terms the collective exit falls
 * by roughly a quarter.
 *
 * That is the trade, and it is not hidden anywhere in here: a floor that is
 * provable but terminal, exchanged for a market with no ceiling. A platform that
 * prefers the floor sets no migrator and this contract never touches its launches.
 *
 * ## Price continuity
 *
 * The pool opens at exactly the price the curve closed at. `FolioToken` sizes the
 * token side as `reserve / closingPrice`, which is always strictly less than the
 * curve's unsold inventory, and the remainder is simply never minted. Seeding with
 * everything unsold instead would open the pool *below* the closing price and hand
 * the last buyers an instant loss — the dump graduation is supposed to prevent,
 * arriving under a different name.
 *
 * ## Why the liquidity cannot be pulled
 *
 * The position is opened by this contract, in its own name, through
 * `PoolManager.modifyLiquidity`. There is no function here that removes liquidity,
 * no owner, no upgrade path, and no way to reach `modifyLiquidity` with a negative
 * delta — {unlockCallback} only ever adds, and only when this contract itself
 * started the unlock. "Liquidity is locked" is therefore a property of the
 * bytecode rather than a promise about an LP token nobody can find.
 *
 * One consequence worth stating rather than discovering: `getLiquidityForAmounts`
 * rounds the position down, so the pool asks for a few thousand wei less than was
 * released and that remainder stays here, unreachable, forever. It is dust — a few
 * parts per quadrillion of a ten-ETH migration — and the alternative is a sweep
 * function, which is a withdrawal path, which is the one thing this contract must
 * not have. Losing dust is the cheaper side of that trade.
 *
 * The same absence applies to the swap fees the position earns: they accrue to a
 * position no code path can touch. Routing them to creators needs a v4 hook and a
 * collect path, which is deliberately not in this first version — a contract that
 * can collect is a contract with a withdrawal path in it, and that deserves its own
 * review rather than a corner of this one.
 *
 * ## Permissionless
 *
 * Anyone may call {migrate} on any graduated launch whose config names this
 * contract. It is deliberately not automatic on the graduating buy, which would
 * bill one unlucky buyer for a pool deployment. There is nothing to gain by calling
 * it and nothing to gain by withholding it: the terms are fixed by the curve's own
 * state, so the only thing a caller chooses is when, and the pool they get is the
 * pool anyone else would have got.
 */
contract FolioMigrator is IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using BalanceDeltaLibrary for BalanceDelta;

    /// @notice The v4 singleton every pool lives in.
    IPoolManager public immutable poolManager;

    /// @notice Swap fee of the pools this creates, in hundredths of a bip.
    ///         `10_000` is 1%, the tier memecoin pairs normally trade at.
    uint24 public immutable poolFee;

    /// @notice Tick spacing of the pools this creates. Pairs with `poolFee`;
    ///         `200` is the conventional spacing for the 1% tier.
    int24 public immutable poolTickSpacing;

    /// @notice The factory whose launches this migrator will serve. A token that
    ///         is not registered there is refused, so a look-alike cannot get a
    ///         pool built for it out of this contract's reputation.
    IFolioFactory public immutable factory;

    /// @notice Pool created for each token, once it has migrated.
    mapping(address token => PoolId) public poolOf;

    /// @notice True once a token has been migrated by this contract.
    mapping(address token => bool) public migrated;

    /**
     * @notice A launch moved onto a pool.
     * @param token The launch.
     * @param poolId The v4 pool now holding its liquidity.
     * @param ethIn Reserve taken from the curve, in wei.
     * @param tokensIn Token units minted to pair against it.
     * @param sqrtPriceX96 Price the pool was opened at — the curve's closing price.
     * @param liquidity Full-range liquidity minted to this contract, permanently.
     */
    event Migrated(
        address indexed token,
        PoolId indexed poolId,
        uint256 ethIn,
        uint256 tokensIn,
        uint160 sqrtPriceX96,
        uint128 liquidity
    );

    error NotAFolioToken();
    error AlreadyMigrated();
    error WrongMigrator();
    error NotPoolManager();
    error NothingReleased();
    error PriceOutOfRange();
    error NoLiquidity();
    error UnexpectedEth();

    /**
     * @param poolManager_ The v4 `PoolManager` on this chain.
     * @param factory_ The `FolioFactory` whose launches may migrate here.
     * @param poolFee_ Swap fee for created pools, in hundredths of a bip.
     * @param poolTickSpacing_ Tick spacing for created pools.
     */
    constructor(
        IPoolManager poolManager_,
        IFolioFactory factory_,
        uint24 poolFee_,
        int24 poolTickSpacing_
    ) {
        poolManager = poolManager_;
        factory = factory_;
        poolFee = poolFee_;
        poolTickSpacing = poolTickSpacing_;
    }

    /// @dev Receives the reserve from `releaseForMigration`, and nothing else.
    ///      Native ETH refunds from the pool manager would arrive here too, but
    ///      {unlockCallback} settles an exact amount and leaves none.
    receive() external payable {}

    /**
     * @notice Move a graduated launch onto a v4 pool. Callable by anyone, once
     *         per launch.
     * @param token The launch to migrate. Must be registered with {factory},
     *        must name this contract as its migrator, and must have graduated.
     * @return key The pool that now holds its liquidity.
     * @return liquidity Full-range liquidity minted, and never removable.
     */
    function migrate(FolioToken token)
        external
        returns (PoolKey memory key, uint128 liquidity)
    {
        if (!factory.isFolioToken(address(token))) revert NotAFolioToken();
        if (migrated[address(token)]) revert AlreadyMigrated();
        // The token enforces this too — it will only pay its own `migrator`. Read
        // here as well so a launch pointed at some other migrator fails with a
        // reason rather than an access-control revert from inside the token.
        if (token.migrator() != address(this)) revert WrongMigrator();

        migrated[address(token)] = true;

        // The token checks graduation, single use and an empty reserve. Anything
        // it refuses reverts the whole call, which is what should happen.
        (uint256 ethIn, uint256 tokensIn) = token.releaseForMigration();
        if (ethIn == 0 || tokensIn == 0) revert NothingReleased();

        // ETH is currency0 against any token, since address(0) sorts below every
        // address. No wrapping, and no branch on ordering.
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: poolFee,
            tickSpacing: poolTickSpacing,
            hooks: IHooks(address(0))
        });

        uint160 sqrtPriceX96 = _sqrtPriceX96(ethIn, tokensIn);
        poolManager.initialize(key, sqrtPriceX96);

        liquidity = abi.decode(
            poolManager.unlock(abi.encode(key, sqrtPriceX96, ethIn, tokensIn)), (uint128)
        );
        if (liquidity == 0) revert NoLiquidity();

        poolOf[address(token)] = key.toId();
        emit Migrated(address(token), key.toId(), ethIn, tokensIn, sqrtPriceX96, liquidity);
    }

    /**
     * @notice v4 unlock callback. Adds the full-range position and pays for it.
     * @dev The only place this contract calls `modifyLiquidity`, and the delta it
     *      passes is always positive — there is no encoding of this payload that
     *      removes liquidity, which is what makes the lock structural.
     */
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        (PoolKey memory key, uint160 sqrtPriceX96, uint256 amount0, uint256 amount1) =
            abi.decode(data, (PoolKey, uint160, uint256, uint256));

        // Full range, snapped inward to legal multiples of the spacing.
        int24 tickLower = _floorToSpacing(TickMath.MIN_TICK, key.tickSpacing);
        int24 tickUpper = _ceilToSpacing(TickMath.MAX_TICK, key.tickSpacing);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );

        if (liquidity == 0) revert NoLiquidity();

        // The one `modifyLiquidity` in this contract, and its delta is always
        // positive. There is no payload that reaches this line with a removal.
        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        // Deltas owed are negative. Pay exactly what the pool asked for, which is
        // at most what was released — `getLiquidityForAmounts` rounds down.
        int128 delta0 = callerDelta.amount0();
        int128 delta1 = callerDelta.amount1();

        if (delta0 < 0) poolManager.settle{value: uint256(uint128(-delta0))}();
        if (delta1 < 0) {
            poolManager.sync(key.currency1);
            IERC20Minimal(Currency.unwrap(key.currency1)).transfer(
                address(poolManager), uint256(uint128(-delta1))
            );
            poolManager.settle();
        }

        return abi.encode(liquidity);
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /**
     * @dev `sqrt(amount1 / amount0) * 2 ** 96`, computed as
     *      `sqrt(mulDiv(amount1, 2 ** 192, amount0))` so the 512-bit intermediate
     *      is handled rather than overflowed. The pool's price is currency1 per
     *      currency0 — tokens per wei — which is the reciprocal of the curve's
     *      wei-per-token, and taking it from the released amounts directly means
     *      the two cannot disagree about which way up it is.
     */
    function _sqrtPriceX96(uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint160 sqrtPriceX96)
    {
        uint256 ratio = Math.mulDiv(amount1, 1 << 192, amount0);
        uint256 root = Math.sqrt(ratio);
        if (root < TickMath.MIN_SQRT_PRICE || root > TickMath.MAX_SQRT_PRICE) {
            revert PriceOutOfRange();
        }
        sqrtPriceX96 = uint160(root);
    }

    /// @dev Toward zero from the minimum, so the tick stays inside the legal range.
    function _floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        return (tick / spacing) * spacing;
    }

    /// @dev Toward zero from the maximum, for the same reason.
    function _ceilToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        return (tick / spacing) * spacing;
    }
}
