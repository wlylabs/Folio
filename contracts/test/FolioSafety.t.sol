// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";

/**
 * Stage 3: the safety layer.
 *
 * Grouped by the guarantee each section defends rather than by function:
 *
 *  A. The pause stops trading and stops nothing else — in particular it does not
 *     stop a single view, because a halted market is one people are still entitled
 *     to read.
 *  B. The owner seat can be handed over but never lost, and the handover is not
 *     complete until the recipient proves it can transact.
 *  C. The reserve cap is a real ceiling: buying into it lands exactly on it,
 *     leaves the launch usable, and cannot be widened by the party it bounds.
 *  D. The price-move signal fires when it should, stays quiet when it should, and
 *     never blocks a trade.
 *  E. Every privileged action leaves a log entry naming who did it and when.
 *  F. The reentrancy guards are applied consistently across *all* the ETH-moving
 *     functions, not only within each one — cross-function re-entry is the case a
 *     per-function audit misses.
 */
contract FolioSafetyTest is Test {
    FolioFactory internal factory;
    FolioToken internal token;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant SUPPLY = 1_000_000;
    uint256 internal constant UNIT = 1e18;
    uint256 internal constant BPS = 10_000;
    uint16 internal constant FEE_BPS = 100;
    /// Fire the monitoring signal when one trade doubles or halves the price.
    uint16 internal constant ALERT_BPS = 10_000;

    bytes32 internal constant PAUSED_TOPIC = keccak256("EmergencyPaused(address,uint256)");
    bytes32 internal constant UNPAUSED_TOPIC = keccak256("EmergencyUnpaused(address,uint256)");
    bytes32 internal constant CONFIG_TOPIC =
        keccak256("DefaultConfigUpdated(address,(uint256,uint256,uint256,uint16,uint16),uint256)");
    bytes32 internal constant FEES_TOPIC = keccak256("FeesClaimed(address,uint256,uint256)");
    bytes32 internal constant MOVE_TOPIC =
        keccak256("LargePriceMove(address,uint256,uint256,uint256)");

    function _config() internal pure returns (CurveConfig memory) {
        return CurveConfig({
            virtualEthReserve: 2 ether,
            maxReserveCap: 5 ether,
            graduationThreshold: 4 ether,
            feeBps: FEE_BPS,
            priceMoveAlertBps: ALERT_BPS
        });
    }

    function setUp() public {
        factory = new FolioFactory(owner, _config());
        token = _create(SUPPLY);

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // =======================================================================
    // A. Emergency pause
    // =======================================================================

    /**
     * The checklist's first line: while paused, everything that changes state must
     * refuse. `claimFees` is the one deliberate exception and is asserted here
     * rather than merely excluded, so that the carve-out is a stated property
     * instead of a gap — the stop exists to contain a curve bug, not to withhold a
     * creator's earnings.
     */
    function test_Pause_EveryStateChangingFunctionReverts() public {
        uint256 held = _buy(alice, 1 ether, 0);

        vm.prank(owner);
        factory.pause();

        vm.prank(alice);
        vm.expectRevert(FolioToken.TradingPaused.selector);
        token.buy{value: 1 ether}(0);

        vm.prank(alice);
        vm.expectRevert(FolioToken.TradingPaused.selector);
        token.sell(held, 0);

        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createToken("Blocked", "BLK", SUPPLY);

        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createToken("Blocked", "BLK", SUPPLY, 1 ether);

        // The carve-out.
        vm.prank(creator);
        assertGt(token.claimFees(), 0, "pause must not withhold creator fees");
    }

    /**
     * The other half of the same requirement, and the reason the pause is safe to
     * hold for a while: it takes nothing away from the people whose money is in the
     * contract except the ability to move it. Reached over `staticcall` so the EVM
     * itself enforces that none of these write.
     */
    function test_Pause_EveryViewStaysCallable() public {
        _buy(alice, 1 ether, 0);
        uint256 held = token.balanceOf(alice);

        vm.prank(owner);
        factory.pause();

        bytes[] memory calls = new bytes[](24);
        calls[0] = abi.encodeCall(token.name, ());
        calls[1] = abi.encodeCall(token.symbol, ());
        calls[2] = abi.encodeCall(token.decimals, ());
        calls[3] = abi.encodeCall(token.totalSupply, ());
        calls[4] = abi.encodeCall(token.balanceOf, (alice));
        calls[5] = abi.encodeCall(token.allowance, (alice, bob));
        calls[6] = abi.encodeCall(token.creator, ());
        calls[7] = abi.encodeCall(token.factory, ());
        calls[8] = abi.encodeCall(token.feeBps, ());
        calls[9] = abi.encodeCall(token.priceMoveAlertBps, ());
        calls[10] = abi.encodeCall(token.graduated, ());
        calls[11] = abi.encodeCall(token.virtualEthReserve, ());
        calls[12] = abi.encodeCall(token.maxReserveCap, ());
        calls[13] = abi.encodeCall(token.graduationThreshold, ());
        calls[14] = abi.encodeCall(token.curveSupply, ());
        calls[15] = abi.encodeCall(token.tokensSold, ());
        calls[16] = abi.encodeCall(token.ethReserve, ());
        calls[17] = abi.encodeCall(token.feesAccrued, ());
        calls[18] = abi.encodeCall(token.curveTokenReserve, ());
        calls[19] = abi.encodeCall(token.currentPrice, ());
        calls[20] = abi.encodeCall(token.marketCap, ());
        calls[21] = abi.encodeCall(token.circulatingMarketCap, ());
        calls[22] = abi.encodeCall(token.ethHeadroom, ());
        calls[23] = abi.encodeCall(token.tradingPaused, ());

        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = address(token).staticcall(calls[i]);
            assertTrue(ok, string.concat("token view ", vm.toString(i), " failed while paused"));
            assertGt(ret.length, 0);
        }

        // The pricing views specifically — the ones a UI needs to keep rendering a
        // position's worth while the market is stopped.
        bytes[] memory quotes = new bytes[](5);
        quotes[0] = abi.encodeCall(token.getBuyPrice, (1000 * UNIT));
        quotes[1] = abi.encodeCall(token.getSellPrice, (held));
        quotes[2] = abi.encodeCall(token.getBuyQuote, (0.5 ether));
        quotes[3] = abi.encodeCall(token.getReserveBalance, ());
        quotes[4] = abi.encodeCall(token.getOutstandingSellObligation, ());

        for (uint256 i = 0; i < quotes.length; i++) {
            (bool ok, bytes memory ret) = address(token).staticcall(quotes[i]);
            assertTrue(ok, string.concat("quote ", vm.toString(i), " failed while paused"));
            assertGt(ret.length, 0);
        }

        // And the factory's own views.
        bytes[] memory f = new bytes[](6);
        f[0] = abi.encodeCall(factory.owner, ());
        f[1] = abi.encodeCall(factory.pendingOwner, ());
        f[2] = abi.encodeCall(factory.paused, ());
        f[3] = abi.encodeCall(factory.tokenCount, ());
        f[4] = abi.encodeCall(factory.implementation, ());
        f[5] = abi.encodeCall(factory.isFolioToken, (address(token)));

        for (uint256 i = 0; i < f.length; i++) {
            (bool ok,) = address(factory).staticcall(f[i]);
            assertTrue(ok, string.concat("factory view ", vm.toString(i), " failed while paused"));
        }
    }

    /// Callable is not the same as honest. The numbers must still be the real ones,
    /// not a frozen or zeroed snapshot.
    function test_Pause_ViewsStillReportTheTruth() public {
        _buy(alice, 1 ether, 0);

        uint256 price = token.currentPrice();
        uint256 reserve = token.ethReserve();
        uint256 obligation = token.getOutstandingSellObligation();
        uint256 sellQuote = token.getSellPrice(token.balanceOf(alice));

        vm.prank(owner);
        factory.pause();

        assertTrue(token.tradingPaused(), "the pause itself must be visible");
        assertEq(token.currentPrice(), price);
        assertEq(token.ethReserve(), reserve);
        assertEq(token.getOutstandingSellObligation(), obligation);
        assertEq(token.getSellPrice(token.balanceOf(alice)), sellQuote);
        assertGe(token.reserveHealthBps(), BPS, "solvency must stay auditable while stopped");
    }

    function test_Pause_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.pause();

        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, creator)
        );
        factory.pause();

        vm.prank(owner);
        factory.pause();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.unpause();
    }

    /// A pending owner is not an owner. Until it accepts, it holds nothing.
    function test_Pause_PendingOwnerCannotPause() public {
        vm.prank(owner);
        factory.transferOwnership(stranger);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.pause();
    }

    /// The stop has to be releasable, or it is not a pause, it is a bricking.
    function test_Pause_TradingResumesCleanlyAfterUnpause() public {
        uint256 held = _buy(alice, 1 ether, 0);

        vm.prank(owner);
        factory.pause();
        vm.prank(owner);
        factory.unpause();

        assertFalse(token.tradingPaused());
        _buy(bob, 0.5 ether, 0);
        vm.prank(alice);
        assertGt(token.sell(held, 0), 0);
        _assertSolvent();
    }

    /// A pause window must not cost anyone their exit. Everything that was owed
    /// before it is still owed and still payable after it.
    function test_Pause_StrandsNobodysFunds() public {
        uint256 a = _buy(alice, 1 ether, 0);
        uint256 b = _buy(bob, 2 ether, 0);

        vm.prank(owner);
        factory.pause();
        assertGe(token.getReserveBalance(), token.getOutstandingSellObligation());
        vm.prank(owner);
        factory.unpause();

        vm.prank(bob);
        token.sell(b, 0);
        vm.prank(alice);
        token.sell(a, 0);

        assertEq(token.totalSupply(), 0);
        _assertSolvent();
    }

    // =======================================================================
    // B. Ownership
    // =======================================================================

    /**
     * The checklist's third line. The transfer is a proposal, not a move: the old
     * address keeps every power until the new one accepts, so a transfer to an
     * address nobody controls costs nothing.
     */
    function test_Ownership_OldOwnerKeepsPowerUntilAccepted() public {
        vm.prank(owner);
        factory.transferOwnership(stranger);

        assertEq(factory.owner(), owner, "ownership moved before acceptance");
        assertEq(factory.pendingOwner(), stranger);

        // The incumbent is still fully in charge.
        vm.prank(owner);
        factory.pause();
        assertTrue(factory.paused());
        vm.prank(owner);
        factory.unpause();

        vm.prank(stranger);
        factory.acceptOwnership();
        assertEq(factory.owner(), stranger);
        assertEq(factory.pendingOwner(), address(0), "pending slot not cleared");
    }

    function test_Ownership_OnlyThePendingOwnerCanAccept() public {
        vm.prank(owner);
        factory.transferOwnership(stranger);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        factory.acceptOwnership();

        assertEq(factory.owner(), owner);
    }

    /// Naming a second recipient replaces the first — a mistaken proposal is
    /// undone by superseding it, and the superseded address is left with nothing.
    function test_Ownership_SecondTransferReplacesThePending() public {
        vm.prank(owner);
        factory.transferOwnership(stranger);
        vm.prank(owner);
        factory.transferOwnership(alice);

        assertEq(factory.pendingOwner(), alice);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.acceptOwnership();

        vm.prank(alice);
        factory.acceptOwnership();
        assertEq(factory.owner(), alice);
    }

    /// After acceptance the powers move wholesale — the new owner gets all of them
    /// and the old one is left with none.
    function test_Ownership_PowersMoveWholesaleOnAcceptance() public {
        vm.prank(owner);
        factory.transferOwnership(stranger);
        vm.prank(stranger);
        factory.acceptOwnership();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        factory.pause();

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        factory.setDefaultConfig(_config());

        vm.prank(stranger);
        factory.pause();
        assertTrue(factory.paused());
        vm.prank(stranger);
        factory.setDefaultConfig(_config());
    }

    /**
     * The reason two-step is worth the extra transaction: proposing the wrong
     * address is recoverable, because an address that cannot transact cannot
     * accept. Nothing has moved and the incumbent is unaffected.
     */
    function test_Ownership_TransferToAnUnreachableAddressChangesNothing() public {
        vm.prank(owner);
        factory.transferOwnership(address(0xdead));

        assertEq(factory.owner(), owner);
        vm.prank(owner);
        factory.pause();
        assertTrue(factory.paused());

        // And it is undone by simply proposing someone else.
        vm.prank(owner);
        factory.transferOwnership(stranger);
        assertEq(factory.pendingOwner(), stranger);
    }

    /**
     * Renouncing is the one remaining way to make an irreversible mistake in a
     * single transaction: it would destroy the emergency stop forever. Closed to
     * everyone, the owner included.
     */
    function test_Ownership_RenounceIsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(FolioFactory.RenounceDisabled.selector);
        factory.renounceOwnership();

        vm.prank(stranger);
        vm.expectRevert(FolioFactory.RenounceDisabled.selector);
        factory.renounceOwnership();

        assertEq(factory.owner(), owner, "owner seat survived a renounce attempt");
        vm.prank(owner);
        factory.pause();
        assertTrue(factory.paused(), "the stop still works");
    }

    // =======================================================================
    // C. Per-launch reserve cap
    // =======================================================================

    function test_Cap_CreatorCanChooseALowerCap() public {
        FolioToken small = _createCapped(SUPPLY, 1 ether);

        assertEq(small.maxReserveCap(), 1 ether);
        assertEq(small.ethHeadroom(), 1 ether);
        // The default threshold sat above the chosen cap, so it clamped down onto
        // it: a launch cannot be asked to graduate at a number its reserve is
        // forbidden to reach.
        assertEq(small.graduationThreshold(), 1 ether);
    }

    function test_Cap_ZeroMeansThePlatformDefault() public {
        FolioToken byDefault = _createCapped(SUPPLY, 0);
        assertEq(byDefault.maxReserveCap(), 5 ether);
        assertEq(byDefault.graduationThreshold(), 4 ether);
    }

    /// The direction that matters: a creator may tighten their own blast radius and
    /// may never widen it, so the platform ceiling always binds.
    function test_Cap_CreatorCannotExceedThePlatformDefault() public {
        vm.prank(creator);
        vm.expectRevert(FolioFactory.ReserveCapAboveDefault.selector);
        factory.createToken("Greedy", "GRD", SUPPLY, 5 ether + 1);

        uint256 wayOver = factory.MAX_RESERVE_CAP() + 1;
        vm.prank(creator);
        vm.expectRevert(FolioFactory.ReserveCapAboveDefault.selector);
        factory.createToken("Greedy", "GRD", SUPPLY, wayOver);
    }

    function test_Cap_RejectsBelowTheMinimum() public {
        uint256 floor_ = factory.MIN_RESERVE_CAP();

        vm.prank(creator);
        vm.expectRevert(FolioFactory.ReserveCapTooLow.selector);
        factory.createToken("Dust", "DST", SUPPLY, floor_ - 1);

        // Exactly at the floor is fine.
        FolioToken atFloor = _createCapped(SUPPLY, floor_);
        assertEq(atFloor.maxReserveCap(), floor_);
    }

    /// Lowering the platform default also lowers what any future creator may ask
    /// for, because the check reads the live default rather than a constant.
    function test_Cap_LoweringTheDefaultLowersWhatCreatorsMayChoose() public {
        CurveConfig memory tighter = _config();
        tighter.maxReserveCap = 2 ether;
        tighter.graduationThreshold = 2 ether;
        vm.prank(owner);
        factory.setDefaultConfig(tighter);

        vm.prank(creator);
        vm.expectRevert(FolioFactory.ReserveCapAboveDefault.selector);
        factory.createToken("Stale", "STL", SUPPLY, 3 ether);

        FolioToken ok = _createCapped(SUPPLY, 2 ether);
        assertEq(ok.maxReserveCap(), 2 ether);
    }

    /**
     * The checklist's fourth line, on the graduation-free path so the *cap* is what
     * binds. Buy right into it: the reserve lands exactly on the cap, the excess
     * comes back, and the launch is closed to buys but otherwise entirely healthy —
     * not crashed, not stuck.
     */
    function test_Cap_BuyingIntoItLandsExactlyOnItAndRefunds() public {
        FolioToken capped = _createUncapped(1 ether);

        uint256 before = alice.balance;
        vm.prank(alice);
        capped.buy{value: 10 ether}(0);

        assertEq(capped.ethReserve(), 1 ether, "reserve did not land exactly on the cap");
        assertEq(capped.ethHeadroom(), 0);
        assertFalse(capped.graduated(), "the cap is not graduation");

        // Charged for the cap plus the fee on it, and not a wei more.
        uint256 spent = before - alice.balance;
        uint256 expected = (1 ether * BPS + (BPS - FEE_BPS) - 1) / (BPS - FEE_BPS);
        assertEq(spent, expected);
        assertLt(spent, 10 ether, "no refund happened");

        // Closed to buys, open to everything else.
        vm.prank(bob);
        vm.expectRevert(FolioToken.CurveClosed.selector);
        capped.buy{value: 1 ether}(0);

        assertGe(capped.getReserveBalance(), capped.getOutstandingSellObligation());
        // Read the balance before arming the prank: `vm.prank` applies to the very
        // next call, and a getter in the argument list would consume it.
        uint256 half = capped.balanceOf(alice) / 2;
        vm.prank(alice);
        assertGt(capped.sell(half, 0), 0, "capped launch cannot sell");
    }

    /// The same edge approached in small steps rather than one overshoot, because
    /// "walks up to the boundary" and "jumps over it" are different code paths.
    function test_Cap_WalkingUpToTheEdgeStaysUsable() public {
        FolioToken capped = _createUncapped(1 ether);

        // Five steps of 0.18 ETH put ~0.89 ETH of the 1 ETH cap in the reserve,
        // leaving a slice too small for the next whole step to fit.
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(alice);
            capped.buy{value: 0.18 ether}(0);
            assertLe(capped.ethReserve(), 1 ether, "reserve stepped over the cap");
        }

        // That last slice is still buyable — the thing a revert-at-cap design would
        // have made unreachable without an exactly-sized trade.
        uint256 remaining = capped.ethHeadroom();
        assertGt(remaining, 0, "test did not actually approach the cap");
        assertLt(remaining, 0.18 ether, "the next whole step would still have fit");

        vm.prank(bob);
        capped.buy{value: 5 ether}(0);
        assertEq(capped.ethReserve(), 1 ether);
        assertEq(capped.ethHeadroom(), 0);

        // And everyone can still get out.
        uint256 aliceHeld = capped.balanceOf(alice);
        vm.prank(alice);
        capped.sell(aliceHeld, 0);

        uint256 bobHeld = capped.balanceOf(bob);
        vm.prank(bob);
        capped.sell(bobHeld, 0);
        assertEq(capped.totalSupply(), 0);
    }

    /// The invariant the whole feature exists for, over arbitrary caps and trades.
    function testFuzz_Cap_ReserveNeverExceedsIt(uint256 capChoice, uint256 ethIn) public {
        capChoice = bound(capChoice, factory.MIN_RESERVE_CAP(), 5 ether);
        ethIn = bound(ethIn, 1e12, 50 ether);

        FolioToken capped = _createUncapped(capChoice);
        vm.deal(alice, ethIn + 1 ether);

        vm.prank(alice);
        try capped.buy{value: ethIn}(0) {} catch {}

        assertLe(capped.ethReserve(), capChoice, "reserve exceeded the cap");
        assertGe(capped.getReserveBalance(), capped.getOutstandingSellObligation());
    }

    /// The event has to describe the launch that actually exists, not the default
    /// it was derived from, or an indexer will show every capped launch wrong.
    function test_Cap_EmittedConfigIsTheEffectiveOne() public {
        vm.recordLogs();
        vm.prank(creator);
        factory.createToken("Capped", "CAP", SUPPLY, 1 ether);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256(
            "TokenCreated(address,address,string,string,uint256,(uint256,uint256,uint256,uint16,uint16))"
        );
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != topic) continue;
            found = true;
            (,,, CurveConfig memory cfg) =
                abi.decode(logs[i].data, (string, string, uint256, CurveConfig));
            assertEq(cfg.maxReserveCap, 1 ether, "event reported the default, not the choice");
            assertEq(cfg.graduationThreshold, 1 ether, "event missed the threshold clamp");
        }
        assertTrue(found, "TokenCreated not emitted");
    }

    /// A launch's terms are frozen at creation. Nothing the owner can do — and
    /// there is nothing else it *can* do — reaches a live launch's cap.
    function test_Cap_IsFrozenAgainstEveryOwnerLever() public {
        _buy(alice, 1 ether, 0);
        uint256 cap = token.maxReserveCap();

        CurveConfig memory changed = _config();
        changed.maxReserveCap = 2 ether;
        changed.graduationThreshold = 1 ether;
        vm.prank(owner);
        factory.setDefaultConfig(changed);

        vm.prank(owner);
        factory.pause();
        vm.prank(owner);
        factory.unpause();

        assertEq(token.maxReserveCap(), cap, "a live launch's cap moved");
        assertEq(token.graduationThreshold(), 4 ether);
    }

    // =======================================================================
    // D. The price-move signal
    // =======================================================================

    /// A 1 ETH buy against a 2 ETH virtual reserve more than doubles the price, so
    /// it trips the 10_000 bps threshold.
    function test_PriceMove_FiresOnALargeBuy() public {
        uint256 priceBefore = token.currentPrice();

        vm.recordLogs();
        _buy(alice, 1 ether, 0);

        (bool fired, address trader, uint256 from, uint256 to, uint256 moveBps) = _lastMove();
        assertTrue(fired, "large buy did not signal");
        assertEq(trader, alice);
        assertEq(from, priceBefore);
        assertEq(to, token.currentPrice(), "signal disagrees with settled state");
        assertGe(moveBps, ALERT_BPS);
    }

    function test_PriceMove_FiresOnALargeSell() public {
        uint256 held = _buy(alice, 1 ether, 0);
        uint256 priceBefore = token.currentPrice();

        vm.recordLogs();
        vm.prank(alice);
        token.sell(held, 0);

        (bool fired,, uint256 from, uint256 to, uint256 moveBps) = _lastMove();
        assertTrue(fired, "large sell did not signal");
        assertEq(from, priceBefore);
        assertEq(to, token.currentPrice());
        assertLt(to, from, "a sell must move the price down");
        assertGe(moveBps, ALERT_BPS);
    }

    /// The point of measuring against the lower price: a halving and a doubling
    /// read the same magnitude, so one threshold covers both directions. Measured
    /// against `priceBefore` instead, a fall could never exceed 10_000 bps and this
    /// threshold would be unreachable on the sell side.
    function test_PriceMove_ThresholdIsSymmetricInBothDirections() public {
        vm.recordLogs();
        uint256 held = _buy(alice, 1 ether, 0);
        (bool roseFired,,,, uint256 upBps) = _lastMove();

        vm.recordLogs();
        vm.prank(alice);
        token.sell(held, 0);
        (bool fellFired,,,, uint256 downBps) = _lastMove();

        assertTrue(roseFired && fellFired, "one direction did not signal");
        // The sell retraces the buy's path, so the two magnitudes match bar the
        // fee and rounding.
        assertApproxEqRel(upBps, downBps, 0.02e18, "the metric is direction-biased");
    }

    function test_PriceMove_QuietOnASmallTrade() public {
        vm.recordLogs();
        _buy(alice, 0.05 ether, 0);

        (bool fired,,,,) = _lastMove();
        assertFalse(fired, "a 2.5% price move should not be newsworthy");
    }

    function test_PriceMove_DisabledAtZero() public {
        CurveConfig memory quiet = _config();
        quiet.priceMoveAlertBps = 0;
        vm.prank(owner);
        factory.setDefaultConfig(quiet);
        FolioToken silent = _create(SUPPLY);

        vm.recordLogs();
        vm.prank(alice);
        silent.buy{value: 3 ether}(0);

        (bool fired,,,,) = _lastMove();
        assertFalse(fired, "signal fired with the threshold disabled");
    }

    /**
     * The defining property: this is monitoring, not a circuit breaker. A trade
     * that trips it settles exactly as it would have otherwise.
     */
    function test_PriceMove_NeverBlocksTheTrade() public {
        uint256 quoted;
        (quoted,,) = token.getBuyQuote(3 ether);

        vm.recordLogs();
        uint256 got = _buy(alice, 3 ether, 0);

        (bool fired,,,,) = _lastMove();
        assertTrue(fired, "test needs a trade big enough to trip the signal");
        assertEq(got, quoted, "the signal changed the trade's outcome");
        assertEq(token.balanceOf(alice), got);
        _assertSolvent();
    }

    /// An alert threshold fine enough to fire on every trade is not a signal, so
    /// the factory refuses to configure one.
    function test_PriceMove_ConfigRejectsATooFineThreshold() public {
        CurveConfig memory bad = _config();
        bad.priceMoveAlertBps = factory.MIN_PRICE_MOVE_ALERT_BPS() - 1;
        vm.prank(owner);
        vm.expectRevert(FolioFactory.InvalidPriceMoveAlert.selector);
        factory.setDefaultConfig(bad);

        // Zero (disabled) and exactly the floor are both fine.
        CurveConfig memory off = _config();
        off.priceMoveAlertBps = 0;
        vm.prank(owner);
        factory.setDefaultConfig(off);

        CurveConfig memory atFloor = _config();
        atFloor.priceMoveAlertBps = factory.MIN_PRICE_MOVE_ALERT_BPS();
        vm.prank(owner);
        factory.setDefaultConfig(atFloor);
    }

    // =======================================================================
    // E. Audit trail
    // =======================================================================

    function test_AuditTrail_PauseNamesWhoAndWhen() public {
        vm.warp(1_800_000_000);

        vm.recordLogs();
        vm.prank(owner);
        factory.pause();

        (bool found, address by, uint256 ts) = _findActorEvent(PAUSED_TOPIC);
        assertTrue(found, "EmergencyPaused not emitted");
        assertEq(by, owner);
        assertEq(ts, block.timestamp);

        vm.warp(block.timestamp + 3600);
        vm.recordLogs();
        vm.prank(owner);
        factory.unpause();

        (found, by, ts) = _findActorEvent(UNPAUSED_TOPIC);
        assertTrue(found, "EmergencyUnpaused not emitted");
        assertEq(by, owner);
        assertEq(ts, block.timestamp);
    }

    /// Post-mortems care who moved a parameter, not only that it moved.
    function test_AuditTrail_ConfigChangeNamesWhoAndWhen() public {
        vm.warp(1_800_000_000);
        vm.recordLogs();

        CurveConfig memory next = _config();
        next.feeBps = 250;
        vm.prank(owner);
        factory.setDefaultConfig(next);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != CONFIG_TOPIC) continue;
            found = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), owner);
            (CurveConfig memory cfg, uint256 ts) = abi.decode(logs[i].data, (CurveConfig, uint256));
            assertEq(cfg.feeBps, 250);
            assertEq(ts, block.timestamp);
        }
        assertTrue(found, "DefaultConfigUpdated not emitted");
    }

    /// The deployment itself is the first entry in the trail.
    function test_AuditTrail_ConstructionIsLogged() public {
        vm.recordLogs();
        new FolioFactory(owner, _config());

        (bool found, address by,) = _findActorEvent(CONFIG_TOPIC);
        assertTrue(found, "construction did not log its config");
        assertEq(by, address(this), "deployer not recorded");
    }

    /// The one privileged function that moves ETH.
    function test_AuditTrail_FeeWithdrawalNamesWhoAndWhen() public {
        vm.warp(1_800_000_000);
        _buy(alice, 1 ether, 0);

        vm.recordLogs();
        vm.prank(creator);
        uint256 claimed = token.claimFees();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != FEES_TOPIC) continue;
            found = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), creator);
            (uint256 amount, uint256 ts) = abi.decode(logs[i].data, (uint256, uint256));
            assertEq(amount, claimed);
            assertEq(ts, block.timestamp);
        }
        assertTrue(found, "FeesClaimed not emitted");
    }

    // =======================================================================
    // F. Reentrancy, swept across functions rather than within them
    // =======================================================================

    /**
     * The case a per-function review misses: the guard has to be the *same* guard
     * across every ETH-moving entry point, or a payout hook can re-enter a
     * different one. All nine combinations of {buy, sell, claimFees} re-entered
     * from a buy refund and from a sell payout are covered here and in stage 2.
     */
    function test_Reentrancy_SellPayoutCannotReenterBuy() public {
        SafetyProbe probe = _fundedProbe();
        probe.doBuy(2 ether);
        uint256 held = token.balanceOf(address(probe));

        probe.arm(SafetyProbe.Action.Buy);
        probe.doSell(held / 2);

        _assertBlocked(probe);
        _assertSolvent();
    }

    function test_Reentrancy_BuyRefundCannotReenterSell() public {
        SafetyProbe probe = _fundedProbe();
        probe.doBuy(1 ether); // unarmed, to give it a balance to try selling

        probe.arm(SafetyProbe.Action.Sell);
        probe.doBuy(10 ether); // overshoots the threshold, so a refund fires

        _assertBlocked(probe);
        _assertSolvent();
    }

    function test_Reentrancy_SellPayoutCannotReenterClaimFees() public {
        SafetyProbe probe = _fundedProbe();
        probe.doBuy(2 ether);
        uint256 held = token.balanceOf(address(probe));

        probe.arm(SafetyProbe.Action.Claim);
        probe.doSell(held / 2);

        _assertBlocked(probe);
        _assertSolvent();
    }

    /**
     * The stronger question behind the guards: is the contract's state *coherent*
     * during the one external call, in case some future path is reachable without
     * the guard? The probe snapshots the accounting from inside the payout hook and
     * this asserts the sell-back guarantee held at that moment — effects really do
     * all land before the interaction.
     */
    function test_Reentrancy_StateIsAlreadySolventDuringThePayout() public {
        SafetyProbe probe = _fundedProbe();
        probe.doBuy(2 ether);
        uint256 held = token.balanceOf(address(probe));

        probe.arm(SafetyProbe.Action.Snapshot);
        probe.doSell(held / 2);

        assertEq(probe.attempts(), 1, "hook never ran; test proves nothing");
        assertEq(probe.snapTotalSupply(), probe.snapTokensSold(), "supply diverged mid-payout");
        assertGe(probe.snapReserve(), probe.snapObligation(), "reserve was short mid-payout");
        assertGe(
            probe.snapBalance(),
            probe.snapReserve() + probe.snapFees(),
            "contract held less than promised mid-payout"
        );
    }

    /**
     * ERC20 transfers are deliberately *not* guarded, and must not be: they touch
     * no ETH and OpenZeppelin's ERC20 makes no external call, so there is nothing
     * to re-enter. This pins that leaving them open costs nothing — a transfer
     * landing in the middle of a payout cannot desynchronise the accounting.
     */
    function test_Reentrancy_TransferDuringPayoutCannotBreakAccounting() public {
        SafetyProbe probe = _fundedProbe();
        probe.doBuy(2 ether);
        uint256 held = token.balanceOf(address(probe));

        probe.setTransferTarget(bob);
        probe.arm(SafetyProbe.Action.Transfer);
        probe.doSell(held / 2);

        assertEq(probe.attempts(), 1, "hook never ran; test proves nothing");
        assertEq(probe.lastError().length, 0, "a plain transfer should not have been blocked");
        assertGt(token.balanceOf(bob), 0, "the transfer did not happen");
        assertEq(
            token.balanceOf(bob) + token.balanceOf(address(probe)),
            held - held / 2,
            "tokens appeared or vanished"
        );
        _assertSolvent();
    }

    /**
     * `createToken` carries a `nonReentrant` guard for the external `initialize`
     * call at its end. The guard must not be mistaken for a once-per-transaction
     * lock: launching two tokens in one transaction is ordinary use and has to keep
     * working. (There is no way to actually re-enter it — the callee is a fresh
     * proxy over an implementation fixed at construction — so this is the half of
     * the guard's behaviour that *can* be observed.)
     */
    function test_Reentrancy_GuardDoesNotBlockSequentialCreates() public {
        vm.startPrank(creator);
        address a = factory.createToken("One", "ONE", SUPPLY);
        address b = factory.createToken("Two", "TWO", SUPPLY, 1 ether);
        address c = factory.createToken("Three", "THR", SUPPLY);
        vm.stopPrank();

        assertTrue(factory.isFolioToken(a) && factory.isFolioToken(b) && factory.isFolioToken(c));
        assertEq(factory.tokenCount(), 4, "the launch from setUp plus these three");
    }

    // =======================================================================
    // Helpers
    // =======================================================================

    function _create(uint256 wholeSupply) internal returns (FolioToken) {
        vm.prank(creator);
        return FolioToken(factory.createToken("Midnight Kettle", "KETL", wholeSupply));
    }

    function _createCapped(uint256 wholeSupply, uint256 cap) internal returns (FolioToken) {
        vm.prank(creator);
        return FolioToken(factory.createToken("Midnight Kettle", "KETL", wholeSupply, cap));
    }

    /// A launch with graduation disabled and a chosen cap, so the *cap* is the
    /// ceiling that binds rather than the graduation threshold.
    function _createUncapped(uint256 cap) internal returns (FolioToken) {
        CurveConfig memory cfg = _config();
        cfg.graduationThreshold = 0;
        vm.prank(owner);
        factory.setDefaultConfig(cfg);
        return _createCapped(SUPPLY, cap);
    }

    function _buy(address who, uint256 value, uint256 minOut) internal returns (uint256) {
        vm.prank(who);
        return token.buy{value: value}(minOut);
    }

    function _fundedProbe() internal returns (SafetyProbe probe) {
        probe = new SafetyProbe(token);
        vm.deal(address(probe), 30 ether);
    }

    function _assertBlocked(SafetyProbe probe) internal view {
        assertEq(probe.attempts(), 1, "hook never ran; test proves nothing");
        assertEq(
            bytes4(probe.lastError()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "cross-function re-entry was not blocked"
        );
    }

    function _assertSolvent() internal view {
        assertGe(
            token.getReserveBalance(),
            token.getOutstandingSellObligation(),
            "reserve cannot cover the sell-back obligation"
        );
        assertGe(
            address(token).balance,
            token.ethReserve() + token.feesAccrued(),
            "contract holds less than it has promised"
        );
        assertEq(token.totalSupply(), token.tokensSold(), "supply and curve accounting diverged");
    }

    /// Pulls the most recent {LargePriceMove} out of the recorded logs.
    function _lastMove()
        internal
        returns (bool found, address trader, uint256 from, uint256 to, uint256 moveBps)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != MOVE_TOPIC) continue;
            found = true;
            trader = address(uint160(uint256(logs[i].topics[1])));
            (from, to, moveBps) = abi.decode(logs[i].data, (uint256, uint256, uint256));
        }
    }

    /// Shared shape of the audit-trail events: `address indexed by` in topic 1 and
    /// a trailing `uint256 timestamp` in the data.
    function _findActorEvent(bytes32 topic)
        internal
        returns (bool found, address by, uint256 loggedAt)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != topic) continue;
            found = true;
            by = address(uint160(uint256(logs[i].topics[1])));
            bytes memory data = logs[i].data;
            // The timestamp is the last word of the non-indexed data in every one
            // of these events, whatever precedes it.
            assembly {
                loggedAt := mload(add(data, mload(data)))
            }
        }
    }
}

/**
 * A holder whose `receive` hook does something else to the token mid-payout.
 *
 * Stage 2's `ReentrantTrader` re-enters the same function it was called from;
 * this one crosses between them, and can also simply read the accounting so a test
 * can assert what the state looked like during the external call. Attempts are
 * wrapped in try/catch so the outer trade still settles and the test can inspect
 * the specific error rather than only observing a revert.
 */
contract SafetyProbe {
    enum Action {
        None,
        Buy,
        Sell,
        Claim,
        Transfer,
        Snapshot
    }

    FolioToken public token;
    Action public action;
    bool public armed;
    uint256 public attempts;
    bytes public lastError;
    address public transferTarget;

    // State read from inside the payout hook.
    uint256 public snapTotalSupply;
    uint256 public snapTokensSold;
    uint256 public snapReserve;
    uint256 public snapObligation;
    uint256 public snapBalance;
    uint256 public snapFees;

    constructor(FolioToken token_) {
        token = token_;
    }

    function arm(Action action_) external {
        action = action_;
        armed = true;
    }

    function setTransferTarget(address to) external {
        transferTarget = to;
    }

    function doBuy(uint256 value) external {
        token.buy{value: value}(0);
    }

    function doSell(uint256 amount) external {
        token.sell(amount, 0);
    }

    receive() external payable {
        if (!armed) return;
        armed = false; // one shot, so the hook cannot recurse on itself
        attempts++;

        // Always snapshot: it is a read, it cannot fail, and every test benefits
        // from being able to see what the contract looked like at this instant.
        snapTotalSupply = token.totalSupply();
        snapTokensSold = token.tokensSold();
        snapReserve = token.ethReserve();
        snapFees = token.feesAccrued();
        snapObligation = token.getOutstandingSellObligation();
        snapBalance = address(token).balance;

        if (action == Action.Buy) {
            try token.buy{value: 0.01 ether}(0) {}
            catch (bytes memory err) {
                lastError = err;
            }
        } else if (action == Action.Sell) {
            try token.sell(1e18, 0) {}
            catch (bytes memory err) {
                lastError = err;
            }
        } else if (action == Action.Claim) {
            try token.claimFees() {}
            catch (bytes memory err) {
                lastError = err;
            }
        } else if (action == Action.Transfer) {
            try token.transfer(transferTarget, token.balanceOf(address(this)) / 2) {}
            catch (bytes memory err) {
                lastError = err;
            }
        }
    }
}
