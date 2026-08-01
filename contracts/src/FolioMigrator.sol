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
 * ## The fees, which are not locked
 *
 * The position's swap fees are a different matter from its principal, and
 * {collectFees} pays them to the launch's creator. Without it a creator's income
 * stops at graduation — precisely when a launch most needs somebody with a reason
 * to look after it — while the pool goes on charging its fee into a position
 * nobody can reach.
 *
 * That is a second `modifyLiquidity`, so it is worth being exact about why it does
 * not undo the paragraph above. It passes a literal zero, and a zero delta cannot
 * shrink a position: the poke only makes the manager realise fees it already owed.
 * Neither branch of {unlockCallback} takes its delta from calldata — `Provide`
 * widens a `uint128`, `Collect` writes `0` — so there is no input to this contract
 * that removes liquidity. The recipient is read off the token rather than supplied
 * by the caller, and `take` sends straight to them, so prompting a collection is a
 * favour to the creator and cannot be redirected into one for the caller.
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
    /// @dev The full key, not just the id — an id is a hash and cannot be turned
    ///      back into the key {collectFees} needs to reach the position.
    mapping(address token => PoolKey) internal _poolKeyOf;

    /// @notice True once a token has been migrated by this contract.
    mapping(address token => bool) public migrated;

    /// @notice The pool a token was migrated into. Zeroed key before migration.
    function poolKeyOf(address token) external view returns (PoolKey memory) {
        return _poolKeyOf[token];
    }

    /// @notice The id of that pool, for reading state out of the manager.
    function poolOf(address token) external view returns (PoolId) {
        return _poolKeyOf[token].toId();
    }

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

    /**
     * @notice What {unlockCallback} was asked to do.
     *
     * The whole safety argument of this contract turns on this enum having
     * exactly two members and neither of them removing liquidity: `Provide`
     * passes `int256(uint256(liquidity))`, `Collect` passes a literal zero. There
     * is no third case and no path where the delta comes from calldata.
     */
    enum Action {
        Provide,
        Collect
    }

    /**
     * @notice The position's accrued swap fees were paid out to the creator.
     * @param token The launch whose pool earned them.
     * @param creator Who received them — read from the token, never from the
     *        caller, so prompting a collection cannot redirect one.
     * @param ethOut Wei paid out.
     * @param tokensOut Token units paid out.
     */
    event FeesCollected(
        address indexed token, address indexed creator, uint256 ethOut, uint256 tokensOut
    );

    error NotAFolioToken();
    error AlreadyMigrated();
    error WrongMigrator();
    error NotPoolManager();
    error NothingReleased();
    error PriceOutOfRange();
    error NoLiquidity();
    error UnexpectedEth();
    /// @notice {collectFees} on a launch that has not migrated. There is no
    ///         position to collect from until there is.
    error NotMigratedYet();
    /// @notice The position has earned nothing since the last collection.
    error NothingToCollect();

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

        bytes memory result = poolManager.unlock(
            abi.encode(Action.Provide, key, address(0), sqrtPriceX96, ethIn, tokensIn)
        );
        (liquidity,,) = abi.decode(result, (uint128, uint256, uint256));
        if (liquidity == 0) revert NoLiquidity();

        _poolKeyOf[address(token)] = key;
        emit Migrated(address(token), key.toId(), ethIn, tokensIn, sqrtPriceX96, liquidity);
    }

    /**
     * @notice Pay the position's accrued swap fees to the launch's creator.
     *         Callable by anyone, as often as anyone likes.
     *
     * Without this a creator's income stops at graduation, which is exactly when
     * a launch most needs someone with a reason to look after it. The pool keeps
     * charging its swap fee either way; the only question is whether the fee
     * reaches a person or accretes to a position nobody can touch.
     *
     * The recipient is read off the token, never taken from the caller, so
     * prompting a collection is a favour to the creator and nothing else. There
     * is no reward for calling and nothing to gain by withholding — the amounts
     * are whatever the pool has accrued, and they wait if nobody calls.
     *
     * @dev This is the second and last `modifyLiquidity` in this contract, and it
     *      passes a literal zero. A zero delta cannot remove liquidity, which is
     *      what keeps the position locked while its earnings are not: the whole
     *      principal stays put and only fees are `take`n.
     *
     *      Fees go straight from the manager to the creator rather than through
     *      here, so this contract never holds them and there is no balance for a
     *      later function to be tempted to sweep.
     * @param token The migrated launch.
     * @return ethOut Wei paid to the creator.
     * @return tokensOut Token units paid to the creator.
     */
    function collectFees(FolioToken token)
        external
        returns (uint256 ethOut, uint256 tokensOut)
    {
        if (!migrated[address(token)]) revert NotMigratedYet();

        PoolKey memory key = _poolKeyOf[address(token)];
        address creator = token.creator();

        bytes memory result =
            poolManager.unlock(abi.encode(Action.Collect, key, creator, uint160(0), uint256(0), uint256(0)));
        (, ethOut, tokensOut) = abi.decode(result, (uint128, uint256, uint256));

        if (ethOut == 0 && tokensOut == 0) revert NothingToCollect();
        emit FeesCollected(address(token), creator, ethOut, tokensOut);
    }

    /**
     * @notice v4 unlock callback. Either opens the position or collects its fees.
     * @dev Both branches call `modifyLiquidity`, and neither can remove liquidity:
     *      `Provide` passes a `uint128` widened to `int256`, which cannot be
     *      negative, and `Collect` passes a literal zero. The delta never comes
     *      from calldata. That is the whole lock, and it is worth re-reading this
     *      function rather than the prose above before believing it.
     */
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        (
            Action action,
            PoolKey memory key,
            address recipient,
            uint160 sqrtPriceX96,
            uint256 amount0,
            uint256 amount1
        ) = abi.decode(data, (Action, PoolKey, address, uint160, uint256, uint256));

        // Full range, snapped inward to legal multiples of the spacing. Recomputed
        // rather than stored: it follows from the spacing, and a stored copy is a
        // second source of truth for where the position lives.
        int24 tickLower = _floorToSpacing(TickMath.MIN_TICK, key.tickSpacing);
        int24 tickUpper = _ceilToSpacing(TickMath.MAX_TICK, key.tickSpacing);

        if (action == Action.Collect) {
            return _collect(key, tickLower, tickUpper, recipient);
        }

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            amount0,
            amount1
        );

        if (liquidity == 0) revert NoLiquidity();

        // Positive by construction: a `uint128` widened into an `int256`.
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

        return abi.encode(liquidity, uint256(0), uint256(0));
    }

    /**
     * @dev Poke the position with a zero delta, which makes the manager realise
     *      the fees it owes, then send them straight to `recipient`.
     *
     *      A zero `liquidityDelta` is the entire safety property here. It cannot
     *      shrink a position, so the principal is untouched and the only balance
     *      that can move is the fee credit the poke just materialised. The
     *      recipient is the creator the caller of {collectFees} read off the
     *      token, and `take` sends there directly — this contract is never in
     *      possession of the money.
     */
    function _collect(PoolKey memory key, int24 tickLower, int24 tickUpper, address recipient)
        private
        returns (bytes memory)
    {
        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: 0,
                salt: bytes32(0)
            }),
            ""
        );

        // With a zero delta the only credits possible are fees, and a credit is
        // positive. A negative one would mean the poke somehow owed the pool
        // money, which cannot happen — the branches below simply never fire.
        int128 delta0 = callerDelta.amount0();
        int128 delta1 = callerDelta.amount1();

        uint256 ethOut = delta0 > 0 ? uint256(uint128(delta0)) : 0;
        uint256 tokensOut = delta1 > 0 ? uint256(uint128(delta1)) : 0;

        if (ethOut > 0) poolManager.take(key.currency0, recipient, ethOut);
        if (tokensOut > 0) poolManager.take(key.currency1, recipient, tokensOut);

        return abi.encode(uint128(0), ethOut, tokensOut);
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
