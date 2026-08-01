// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {FolioMigrator} from "../src/FolioMigrator.sol";
import {IFolioFactory} from "../src/interfaces/IFolioFactory.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";

/**
 * @title FolioMigrationTest
 * @notice The curve handing itself over to a Uniswap v4 pool.
 *
 * Runs against a real `PoolManager` deployed into the test EVM, not a mock, which
 * is why this suite lives under its own cancun profile — v4's manager is built on
 * transient storage and cannot compile at the paris the rest of the project ships
 * at. What it cannot check from here is that the addresses on Robinhood Chain hold
 * the code this deploys locally; that is what the fork job in CI is for.
 *
 * The properties that matter, in the order they matter:
 *
 *  1. **Price continuity.** The pool opens where the curve closed. A migration that
 *     gaps the price is the graduation dump wearing a different hat.
 *  2. **Nothing is stranded.** Everything released reaches the pool; the migrator
 *     keeps no ETH and no tokens.
 *  3. **The liquidity cannot come back out.** Not "the LP token was burned" — there
 *     is no code path, and {test_Lock_MigratorHasNoWayOut} spells out why.
 *  4. **The curve is properly dead.** Selling reverts with a reason rather than
 *     underflowing an empty reserve, and the solvency views stop reporting a
 *     liability nothing can call on.
 */
contract FolioMigrationTest is Test {
    using StateLibrary for IPoolManager;

    IPoolManager internal manager;
    PoolSwapTest internal swapper;
    FolioFactory internal factory;
    FolioMigrator internal migrator;
    FolioToken internal token;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant SUPPLY = 1_000_000_000;
    uint256 internal constant VIRTUAL = 5 ether;
    uint256 internal constant THRESHOLD = 10 ether;
    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant TICK_SPACING = 200;

    function _config(address migrator_) internal pure returns (CurveConfig memory) {
        return CurveConfig({
            virtualEthReserve: VIRTUAL,
            maxReserveCap: 12 ether,
            graduationThreshold: THRESHOLD,
            feeBps: 100,
            priceMoveAlertBps: 10_000,
            sniperWindowSeconds: 0,
            sniperMaxEthPerWallet: 0,
            migrator: migrator_
        });
    }

    function setUp() public {
        manager = IPoolManager(address(new PoolManager(address(this))));
        swapper = new PoolSwapTest(manager);

        // The factory has to exist before the migrator can be pointed at it, and
        // the migrator before a config can name it. Two steps, then the launch.
        factory = new FolioFactory(owner, _config(address(0)));
        migrator = new FolioMigrator(manager, IFolioFactory(address(factory)), POOL_FEE, TICK_SPACING);

        vm.prank(owner);
        factory.setDefaultConfig(_config(address(migrator)));

        vm.prank(creator);
        token = FolioToken(factory.createToken("Midnight Kettle", "KETL", SUPPLY));

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    /// Buy until the curve closes itself.
    function _graduate() internal {
        vm.prank(alice);
        token.buy{value: 20 ether}(0);
        assertTrue(token.graduated(), "the launch should have graduated");
    }

    // -----------------------------------------------------------------------
    // The happy path
    // -----------------------------------------------------------------------

    function test_Migrate_OpensThePoolWhereTheCurveClosed() public {
        _graduate();

        uint256 reserve = token.ethReserve();
        uint256 closingPrice = token.currentPrice();

        (PoolKey memory key, uint128 liquidity) = migrator.migrate(token);
        assertGt(liquidity, 0);

        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());

        // The pool's price is tokens per wei; the curve's is wei per whole token.
        // Recover one from the other and require them to agree to within a basis
        // point, which is as close as a sqrt round trip through Q96 gets.
        uint256 priceX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        uint256 poolWeiPerToken = FullMathLite.mulDiv(1e18, 1 << 192, priceX192);

        assertApproxEqRel(
            poolWeiPerToken,
            closingPrice,
            1e14, // 0.01%
            "the pool did not open at the curve's closing price"
        );

        // And the closing price is the one the curve froze, not a live formula
        // reading a zeroed reserve.
        assertEq(token.currentPrice(), closingPrice);
        assertEq(token.migrationPrice(), closingPrice);
        assertEq(token.ethReserve(), 0);
        assertTrue(token.migrated());

        // Effectively the whole reserve reached the pool — see the dust test for
        // the few thousand wei that cannot.
        assertApproxEqRel(
            address(manager).balance, reserve, 1e12, "the pool did not receive the reserve"
        );
    }

    /**
     * What the migrator keeps, and why it is not zero.
     *
     * `getLiquidityForAmounts` rounds the position down, so the pool asks for
     * slightly less ETH than was released and the remainder stays here with no way
     * out. That is deliberate: the alternative is a sweep function, which is a
     * withdrawal path, which is the one thing this contract must not have.
     *
     * Bounded rather than asserted at zero, and bounded tightly — a gwei against a
     * ten-ETH migration is roughly a part in ten billion. A real settlement bug
     * would not fit under it.
     */
    function test_Migrate_KeepsOnlyRoundingDust() public {
        _graduate();
        uint256 reserve = token.ethReserve();
        migrator.migrate(token);

        uint256 keptEth = address(migrator).balance;
        assertLt(keptEth, 1 gwei, "migrator kept more than rounding dust");
        assertLt(keptEth * 1e9 / reserve, 1, "ETH dust is a meaningful fraction of the reserve");

        // Both legs round, not just the ETH one.
        uint256 keptTokens = token.balanceOf(address(migrator));
        assertLt(keptTokens, 1e12, "migrator kept more than rounding dust in tokens");
        assertLt(
            keptTokens * 1e9 / token.totalSupply(), 1, "token dust is a meaningful fraction"
        );
    }

    /// The pool is a real market, not just initialized state: it takes a swap in
    /// both directions and pays out.
    function test_Migrate_ThePoolActuallyTrades() public {
        _graduate();
        (PoolKey memory key,) = migrator.migrate(token);

        uint256 before = token.balanceOf(bob);
        vm.prank(bob);
        swapper.swap{value: 1 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -1 ether,
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        assertGt(token.balanceOf(bob), before, "a buy on the pool paid out nothing");
    }

    /// The token side is sized from the reserve, so it is always strictly less
    /// than what the curve had left unsold — the remainder is never minted.
    function test_Migrate_LeavesPartOfTheSupplyUnminted() public {
        _graduate();

        uint256 unsoldBefore = token.curveTokenReserve();
        uint256 supplyBefore = token.totalSupply();

        migrator.migrate(token);

        uint256 minted = token.totalSupply() - supplyBefore;
        assertGt(minted, 0);
        assertLt(minted, unsoldBefore, "the pool took the entire remaining inventory");
        assertLt(token.totalSupply(), token.curveSupply(), "the whole supply was minted");

        // And supply accounting still holds, which every other suite depends on.
        assertEq(token.totalSupply(), token.tokensSold());
    }

    // -----------------------------------------------------------------------
    // The curve afterwards
    // -----------------------------------------------------------------------

    function test_After_SellingRevertsWithAReason() public {
        _graduate();
        uint256 held = token.balanceOf(alice);
        migrator.migrate(token);

        vm.prank(alice);
        vm.expectRevert(FolioToken.CurveMigrated.selector);
        token.sell(held, 0);
    }

    function test_After_BuyingIsStillClosed() public {
        _graduate();
        migrator.migrate(token);

        vm.prank(bob);
        vm.expectRevert(FolioToken.CurveClosed.selector);
        token.buy{value: 1 ether}(0);
    }

    /**
     * The reserve is zero and the curve refuses every sell, so there is no
     * obligation left here to be short of. Without the migration branch the
     * health view would read 0% covered against a liability nothing can call on,
     * and every monitor watching it would fire.
     */
    function test_After_SolvencyViewsStopReportingAPhantomLiability() public {
        _graduate();
        migrator.migrate(token);

        assertEq(token.getOutstandingSellObligation(), 0);
        assertEq(token.reserveHealthBps(), 10_000);
        assertEq(token.getReserveBalance(), 0);
    }

    /// Creator fees are outside the reserve and were never part of the migration.
    function test_After_CreatorCanStillClaimFees() public {
        _graduate();
        uint256 accrued = token.feesAccrued();
        assertGt(accrued, 0);

        migrator.migrate(token);

        vm.prank(creator);
        assertEq(token.claimFees(), accrued, "migration swallowed the creator's fees");
    }

    // -----------------------------------------------------------------------
    // Refusals
    // -----------------------------------------------------------------------

    function test_Refuse_MigratingTwice() public {
        _graduate();
        migrator.migrate(token);

        vm.expectRevert(FolioMigrator.AlreadyMigrated.selector);
        migrator.migrate(token);
    }

    function test_Refuse_BeforeGraduation() public {
        vm.prank(alice);
        token.buy{value: 1 ether}(0);
        assertFalse(token.graduated());

        vm.expectRevert(FolioToken.NotGraduated.selector);
        migrator.migrate(token);
    }

    /// A clone somebody made of the implementation behind the platform's back is
    /// not a Folio launch, and does not get a pool built out of this contract.
    function test_Refuse_ATokenTheFactoryDoesNotKnow() public {
        FolioToken impostor = FolioToken(payable(makeAddr("impostor")));
        vm.expectRevert(FolioMigrator.NotAFolioToken.selector);
        migrator.migrate(impostor);
    }

    /// A launch created before the migrator was named keeps the curve forever.
    function test_Refuse_ALaunchWithNoMigrator() public {
        vm.prank(owner);
        factory.setDefaultConfig(_config(address(0)));

        vm.prank(creator);
        FolioToken terminal = FolioToken(factory.createToken("Terminal", "TRM", SUPPLY));
        vm.prank(alice);
        terminal.buy{value: 20 ether}(0);
        assertTrue(terminal.graduated());

        vm.expectRevert(FolioMigrator.WrongMigrator.selector);
        migrator.migrate(terminal);

        // And the token refuses on its own account too, whoever asks.
        vm.expectRevert(FolioToken.NoMigrator.selector);
        terminal.releaseForMigration();
    }

    /// Only the frozen migrator may take the reserve — not the creator, not the
    /// platform, not a caller who noticed the function exists.
    function test_Refuse_AnyoneElseCallingTheRelease() public {
        _graduate();

        vm.prank(creator);
        vm.expectRevert(FolioToken.NotMigrator.selector);
        token.releaseForMigration();

        vm.prank(owner);
        vm.expectRevert(FolioToken.NotMigrator.selector);
        token.releaseForMigration();
    }

    /**
     * Graduated, then everyone sold back out. A pool of nothing is worse than no
     * pool, so the token refuses to release.
     *
     * The reserve is written directly rather than sold to zero, because selling
     * cannot reach zero: rounding on every leg is resolved in the reserve's
     * favour, so a full exit leaves a wei behind by design. This is the same
     * manufactured-state trick, and for the same reason, as the slot write the
     * main suite uses on `ethReserve`. Slot 7, confirmed by
     * `forge inspect FolioToken storage-layout`.
     */
    function test_Refuse_AnEmptyReserve() public {
        _graduate();

        uint256 held = token.balanceOf(alice);
        vm.prank(alice);
        token.sell(held, 0);
        assertEq(token.ethReserve(), 1, "a full exit should leave the rounding wei");

        vm.store(address(token), bytes32(uint256(7)), bytes32(uint256(0)));
        assertEq(token.ethReserve(), 0);

        vm.expectRevert(FolioToken.NothingToMigrate.selector);
        migrator.migrate(token);
    }

    /// The near-empty case that selling *can* reach. Whatever the curve has left,
    /// migration either builds a real pool from it or refuses cleanly — never
    /// half-settles.
    function test_Refuse_OrMigrates_ADustReserve() public {
        _graduate();

        uint256 held = token.balanceOf(alice);
        vm.prank(alice);
        token.sell(held, 0);

        uint256 dust = token.ethReserve();
        assertGt(dust, 0);

        try migrator.migrate(token) returns (PoolKey memory, uint128 liquidity) {
            // If it went through, it went through properly.
            assertGt(liquidity, 0, "migrated with no liquidity");
            assertTrue(token.migrated());
        } catch (bytes memory reason) {
            // And if it refused, it refused before touching the token's state.
            assertEq(bytes4(reason), FolioMigrator.NoLiquidity.selector);
            assertFalse(token.migrated());
        }
    }

    /// The unlock callback is the only place liquidity is added, and the manager
    /// is the only caller that may reach it.
    function test_Refuse_AForgedUnlockCallback() public {
        vm.prank(bob);
        vm.expectRevert(FolioMigrator.NotPoolManager.selector);
        migrator.unlockCallback("");
    }

    // -----------------------------------------------------------------------
    // The lock
    // -----------------------------------------------------------------------

    /**
     * The claim is not "the LP token was burned" — there is no LP token. The
     * position belongs to this contract, which has no function that removes
     * liquidity, no owner, and no upgrade path.
     *
     * Be clear about what this test does and does not establish. It shows the
     * position is real, that it holds the value, and that the migrator itself
     * ends up holding nothing it could hand to anybody. It does *not* prove the
     * absence of a withdrawal path — no test can prove an absence, and a reviewer
     * reading `FolioMigrator` for a second `modifyLiquidity` is what actually
     * establishes that. The one in {unlockCallback} is the only one, and its
     * delta is `int256(uint256(liquidity))`, which cannot be negative.
     */
    function test_Lock_LiquidityLandsInAPositionTheMigratorCannotHold() public {
        _graduate();
        (PoolKey memory key, uint128 liquidity) = migrator.migrate(token);

        // The liquidity is real, and it is the pool's.
        assertEq(manager.getLiquidity(key.toId()), liquidity);
        assertGt(address(manager).balance, 0, "the pool holds no ETH");

        // The migrator kept nothing it could hand to anybody — rounding dust
        // aside, which {test_Migrate_KeepsOnlyRoundingDust} bounds on both legs.
        assertLt(address(migrator).balance, 1 gwei);
        assertLt(token.balanceOf(address(migrator)), 1e12);
    }
}

/// @dev The one 512-bit multiply this suite needs, kept local rather than pulling
///      a v4 library in just to divide by 2**192 once.
library FullMathLite {
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256) {
        unchecked {
            // `b` here is always 2**192 and `a` is 1e18, so the product fits and
            // the general 512-bit path is not needed.
            return (a * b) / denominator;
        }
    }
}
