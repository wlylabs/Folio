// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {FolioTestBase} from "./helpers/FolioTestBase.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";

/**
 * @title FolioAntiSniperTest
 * @notice The opening-window per-wallet buy cap, and the exact boundaries of what
 *         it claims to do.
 *
 * Two properties carry most of the weight here and are worth naming up front.
 *
 * The first is that the cap lives *outside* the curve. Everything the rest of the
 * suite proves about `x * y = k` — the sell-back guarantee, `reserveHealthBps`
 * reading `10_000` on the nose, rounding always favouring the reserve — has to
 * survive the mechanism untouched. {test_Curve_IsUnchangedByTheWindow} pins that
 * down the only way worth doing it: by running the same trade against two launches
 * that differ in nothing but the window, and requiring the curve to land in
 * identical state.
 *
 * The second is that this is a cap on *addresses*, not on people.
 * {test_Sybil_EachWalletGetsItsOwnCap} exists to hold that limitation in place as
 * a tested fact rather than a caveat in a comment somebody can quietly delete. If
 * that test ever starts failing, it means someone has claimed sybil resistance
 * this contract does not have.
 */
contract FolioAntiSniperTest is FolioTestBase {
    uint16 internal constant WINDOW = 120;
    uint256 internal constant WALLET_CAP = 0.1 ether;

    function _config() internal pure override returns (CurveConfig memory) {
        return CurveConfig({
            virtualEthReserve: 2 ether,
            maxReserveCap: 5 ether,
            graduationThreshold: 4 ether,
            feeBps: FEE_BPS,
            priceMoveAlertBps: 10_000,
            sniperWindowSeconds: WINDOW,
            sniperMaxEthPerWallet: WALLET_CAP,
            migrator: address(0)
        });
    }

    /// @dev Past the window on the launch `setUp` created, for the tests that are
    ///      about ordinary trading rather than the opening.
    function _skipWindow() internal {
        vm.warp(token.sniperWindowEndsAt());
    }

    // -----------------------------------------------------------------------
    // The window itself
    // -----------------------------------------------------------------------

    function test_Window_IsOpenAtLaunchAndClosesOnSchedule() public {
        assertTrue(token.sniperWindowActive(), "window should be open at launch");
        assertEq(token.sniperWindowEndsAt(), block.timestamp + WINDOW);

        // One second before the end it is still binding.
        vm.warp(token.sniperWindowEndsAt() - 1);
        assertTrue(token.sniperWindowActive(), "window closed a second early");

        // The boundary itself is outside the window: the check is `<`, not `<=`.
        vm.warp(token.sniperWindowEndsAt());
        assertFalse(token.sniperWindowActive(), "window should be shut at its end");
    }

    function test_Window_ZeroDisablesTheMechanismEntirely() public {
        CurveConfig memory cfg = _config();
        cfg.sniperWindowSeconds = 0;
        cfg.sniperMaxEthPerWallet = 0;
        vm.prank(owner);
        factory.setDefaultConfig(cfg);

        FolioToken free = _createAs(creator, "Unprotected", "UNP", SUPPLY);
        assertFalse(free.sniperWindowActive());
        assertEq(free.sniperWindowEndsAt(), 0);
        assertEq(free.sniperAllowance(alice), type(uint256).max);

        // And a buy far above what the protected launch would have allowed lands
        // whole, with nothing refunded.
        uint256 before = alice.balance;
        _buyOn(free, alice, 3 ether, 0);
        assertEq(before - alice.balance, 3 ether, "an unprotected launch refunds nothing");
        _assertSolventOn(free);
    }

    function test_Window_AllowanceIsUnlimitedOnceItCloses() public {
        _buy(alice, WALLET_CAP, 0);
        assertEq(token.sniperAllowance(alice), 0, "cap should be spent");

        _skipWindow();
        assertEq(
            token.sniperAllowance(alice),
            type(uint256).max,
            "a closed window must stop binding, spent or not"
        );

        // The spend record survives — it is the history of who bought the opening.
        assertEq(token.sniperSpent(alice), WALLET_CAP);
    }

    // -----------------------------------------------------------------------
    // The cap
    // -----------------------------------------------------------------------

    function test_Cap_BuyUnderTheCapIsUntouched() public {
        uint256 spend = WALLET_CAP / 4;
        uint256 before = alice.balance;

        (uint256 quoted, uint256 quotedSpend, uint256 quotedRefund) =
            token.getBuyQuoteFor(spend, alice);
        assertEq(quotedRefund, 0, "an under-cap buy has nothing to refund");

        uint256 got = _buy(alice, spend, 0);
        assertEq(got, quoted, "settlement disagreed with the quote");
        assertEq(before - alice.balance, quotedSpend);
        assertEq(token.sniperSpent(alice), spend);
        assertEq(token.sniperAllowance(alice), WALLET_CAP - spend);
        _assertSolvent();
    }

    /**
     * The headline behaviour: an over-cap buy is trimmed and the rest handed back,
     * rather than reverted. Reverting would make every opening a race in which
     * most transactions burn gas and fail, which is the failure mode the reserve
     * ceiling already refuses for the same reason.
     */
    function test_Cap_OverCapBuyIsClampedAndRefunded() public {
        uint256 sent = 2 ether;
        uint256 before = alice.balance;

        (uint256 quoted, uint256 quotedSpend, uint256 quotedRefund) =
            token.getBuyQuoteFor(sent, alice);
        assertEq(quotedSpend, WALLET_CAP, "the trim should land exactly on the cap");
        assertEq(quotedRefund, sent - WALLET_CAP);

        vm.expectEmit(true, false, false, true, address(token));
        emit FolioToken.SniperClamped(alice, sent, WALLET_CAP);
        uint256 got = _buy(alice, sent, 0);

        assertEq(got, quoted, "settlement disagreed with the quote");
        assertEq(before - alice.balance, WALLET_CAP, "only the capped amount should leave");
        assertEq(token.sniperSpent(alice), WALLET_CAP);
        assertEq(token.sniperAllowance(alice), 0);
        _assertSolvent();
    }

    function test_Cap_AccumulatesAcrossManyBuys() public {
        uint256 slice = WALLET_CAP / 5;
        for (uint256 i = 0; i < 5; i++) {
            _buy(alice, slice, 0);
            assertEq(token.sniperSpent(alice), slice * (i + 1));
            _assertSolvent();
        }
        assertEq(token.sniperAllowance(alice), 0, "five fifths should exhaust the cap");

        // Salami-slicing the cap is not a way through it.
        vm.expectRevert(FolioToken.SniperCapReached.selector);
        _buy(alice, slice, 0);
    }

    function test_Cap_ExhaustedAllowanceRevertsRatherThanBouncingTheWholeSend() public {
        _buy(alice, WALLET_CAP, 0);

        // Nothing to settle, so there is no trade to clamp — this is the one place
        // the window refuses outright, and it says why.
        vm.expectRevert(FolioToken.SniperCapReached.selector);
        _buy(alice, 1 ether, 0);

        // The quote agrees: everything comes back, nothing is bought.
        (uint256 quoted, uint256 spend, uint256 refund) = token.getBuyQuoteFor(1 ether, alice);
        assertEq(quoted, 0);
        assertEq(spend, 0);
        assertEq(refund, 1 ether);
    }

    function test_Cap_StopsBindingAfterTheWindow() public {
        _buy(alice, WALLET_CAP, 0);
        _skipWindow();

        uint256 before = alice.balance;
        _buy(alice, 2 ether, 0);
        assertEq(before - alice.balance, 2 ether, "a closed window must not trim");

        // And the record stops moving, because nothing reads it any more.
        assertEq(token.sniperSpent(alice), WALLET_CAP);
        _assertSolvent();
    }

    function test_Cap_DoesNotTouchSelling() public {
        _buy(alice, WALLET_CAP, 0);
        uint256 held = token.balanceOf(alice);

        // Still inside the window. Selling has never been the sniper's problem and
        // is not throttled here.
        assertTrue(token.sniperWindowActive());
        uint256 out = _sell(alice, held, 0);
        assertGt(out, 0, "selling must stay open during the window");
        assertEq(token.balanceOf(alice), 0);
        _assertSolvent();
    }

    // -----------------------------------------------------------------------
    // Interaction with the reserve ceiling
    // -----------------------------------------------------------------------

    /**
     * Both clamps can bind on one trade. The window trims first, outside the
     * curve; the ceiling then trims what is left, and the two refunds are added,
     * never double-counted. The number to watch is `spent`: it must reflect the
     * ceiling's slice of the *capped* amount, not of what was sent.
     */
    function test_Ceiling_WindowAndReserveCapStack() public {
        // A launch whose headroom is far below one wallet's allowance.
        FolioToken tiny = _createCapped(SUPPLY, 0.05 ether);
        assertTrue(tiny.sniperWindowActive());
        assertEq(tiny.ethHeadroom(), 0.05 ether);

        uint256 sent = 2 ether;
        (, uint256 quotedSpend, uint256 quotedRefund) = tiny.getBuyQuoteFor(sent, alice);
        assertEq(quotedSpend + quotedRefund, sent, "the two refunds must partition the send");
        assertLt(quotedSpend, WALLET_CAP, "the ceiling binds tighter than the cap here");

        uint256 before = alice.balance;
        _buyOn(tiny, alice, sent, 0);

        assertEq(before - alice.balance, quotedSpend);
        assertEq(tiny.ethReserve(), 0.05 ether, "the reserve should land exactly on its cap");
        assertEq(tiny.sniperSpent(alice), quotedSpend, "the record tracks what was spent");
        _assertSolventOn(tiny);
    }

    // -----------------------------------------------------------------------
    // The property the whole design rests on
    // -----------------------------------------------------------------------

    /**
     * The window must be invisible to the curve. Two launches identical but for
     * the window, given the same net ETH, have to end in the same state — same
     * tokens out, same reserve, same `k`, same price.
     */
    function test_Curve_IsUnchangedByTheWindow() public {
        CurveConfig memory off = _config();
        off.sniperWindowSeconds = 0;
        off.sniperMaxEthPerWallet = 0;
        vm.prank(owner);
        factory.setDefaultConfig(off);
        FolioToken unprotected = _createAs(creator, "Unprotected", "UNP", SUPPLY);

        // Exactly the cap, so the protected launch settles it whole and the two
        // trades are the same trade.
        uint256 protectedOut = _buy(alice, WALLET_CAP, 0);
        uint256 unprotectedOut = _buyOn(unprotected, bob, WALLET_CAP, 0);

        assertEq(protectedOut, unprotectedOut, "the window changed what the curve paid out");
        assertEq(token.ethReserve(), unprotected.ethReserve());
        assertEq(token.tokensSold(), unprotected.tokensSold());
        assertEq(token.currentPrice(), unprotected.currentPrice());
        assertEq(_k(token), _k(unprotected));
        assertEq(token.feesAccrued(), unprotected.feesAccrued());
    }

    /// Clamped ETH is refunded before anything is priced, so it must not show up
    /// in the creator's fees either.
    function test_Curve_FeeIsChargedOnTheCappedAmountOnly() public {
        _buy(alice, 2 ether, 0);
        assertEq(
            token.feesAccrued(),
            (WALLET_CAP * FEE_BPS) / BPS,
            "fee was taken on the send rather than on what was spent"
        );
    }

    /// The surplus-free reading is the whole point of keeping this outside the
    /// curve: an opening full of clamped buys must still leave the reserve exactly
    /// covered, not over-covered by trapped ETH.
    function test_Curve_ReserveHealthStaysExact() public {
        address[5] memory fleet = [alice, bob, carol, dave, eve];
        for (uint256 i = 0; i < fleet.length; i++) {
            _buy(fleet[i], 3 ether, 0);
            assertEq(token.reserveHealthBps(), BPS, "clamping left a surplus in the reserve");
        }
        _assertSolvent();
    }

    // -----------------------------------------------------------------------
    // What this does not do
    // -----------------------------------------------------------------------

    /**
     * The limitation, tested so it stays honest. Five addresses get five caps, and
     * nothing on chain can tell whether one person holds all five keys.
     *
     * What the mechanism does buy is visible in the numbers below: taking five
     * caps' worth of the opening costs five funded wallets and five transactions,
     * and leaves five entries in `sniperSpent` for anyone to read afterwards.
     */
    function test_Sybil_EachWalletGetsItsOwnCap() public {
        address[5] memory fleet = [alice, bob, carol, dave, eve];
        for (uint256 i = 0; i < fleet.length; i++) {
            _buy(fleet[i], WALLET_CAP, 0);
            assertEq(token.sniperSpent(fleet[i]), WALLET_CAP);
        }

        assertEq(token.ethReserve(), (WALLET_CAP * 5 * (BPS - FEE_BPS)) / BPS);
        _assertSolvent();
    }

    // -----------------------------------------------------------------------
    // Quoting
    // -----------------------------------------------------------------------

    /// `getBuyQuote` answers for `msg.sender`, which is why a frontend should be
    /// using the explicit form. Inside the window the two genuinely differ.
    function test_Quote_DefaultFormAnswersForTheCaller() public {
        _buy(alice, WALLET_CAP, 0);

        vm.prank(alice);
        (uint256 aliceOut,,) = token.getBuyQuote(1 ether);
        assertEq(aliceOut, 0, "alice has no allowance left");

        vm.prank(bob);
        (uint256 bobOut,,) = token.getBuyQuote(1 ether);
        assertGt(bobOut, 0, "bob has not spent anything");

        assertEq(bobOut, _quoteFor(bob, 1 ether), "the two forms disagreed for bob");
    }

    function _quoteFor(address who, uint256 ethIn) private view returns (uint256 out) {
        (out,,) = token.getBuyQuoteFor(ethIn, who);
    }

    // -----------------------------------------------------------------------
    // Factory bounds
    // -----------------------------------------------------------------------

    function test_Factory_RejectsAWindowPastTheCeiling() public {
        CurveConfig memory bad = _config();
        bad.sniperWindowSeconds = factory.MAX_SNIPER_WINDOW_SECONDS() + 1;
        vm.prank(owner);
        vm.expectRevert(FolioFactory.InvalidSniperWindow.selector);
        factory.setDefaultConfig(bad);
    }

    function test_Factory_RejectsALiveWindowWithAnUnusableCap() public {
        CurveConfig memory bad = _config();
        bad.sniperMaxEthPerWallet = factory.MIN_SNIPER_MAX_ETH_PER_WALLET() - 1;
        vm.prank(owner);
        vm.expectRevert(FolioFactory.InvalidSniperCap.selector);
        factory.setDefaultConfig(bad);

        // A zero cap is the same mistake in its most obvious form.
        bad.sniperMaxEthPerWallet = 0;
        vm.prank(owner);
        vm.expectRevert(FolioFactory.InvalidSniperCap.selector);
        factory.setDefaultConfig(bad);
    }

    /// With no window there is no cap to be unusable, so the pairing check has to
    /// stay switched off — otherwise every pre-existing config becomes invalid.
    function test_Factory_AcceptsAZeroCapWhenTheWindowIsOff() public {
        CurveConfig memory fine = _config();
        fine.sniperWindowSeconds = 0;
        fine.sniperMaxEthPerWallet = 0;
        vm.prank(owner);
        factory.setDefaultConfig(fine);

        (,,,,, uint16 window, uint256 cap,) = factory.defaultConfig();
        assertEq(window, 0);
        assertEq(cap, 0);
    }

    function test_Factory_AcceptsBothBoundsExactly() public {
        CurveConfig memory edge = _config();
        edge.sniperWindowSeconds = factory.MAX_SNIPER_WINDOW_SECONDS();
        edge.sniperMaxEthPerWallet = factory.MIN_SNIPER_MAX_ETH_PER_WALLET();
        vm.prank(owner);
        factory.setDefaultConfig(edge);

        FolioToken t = _createAs(creator, "Edge", "EDG", SUPPLY);
        assertEq(t.sniperWindowSeconds(), factory.MAX_SNIPER_WINDOW_SECONDS());
        assertEq(t.sniperMaxEthPerWallet(), factory.MIN_SNIPER_MAX_ETH_PER_WALLET());

        // And it is a launch you can actually buy into, at the cap.
        _buyOn(t, alice, factory.MIN_SNIPER_MAX_ETH_PER_WALLET(), 0);
        assertGt(t.balanceOf(alice), 0);
        _assertSolventOn(t);
    }

    // -----------------------------------------------------------------------
    // What a creator may choose
    // -----------------------------------------------------------------------

    function _createWith(uint16 window, uint256 cap) private returns (FolioToken) {
        vm.prank(creator);
        return FolioToken(factory.createToken("Chosen", "CHS", SUPPLY, 0, window, cap));
    }

    function test_Creator_InheritsTheDefaultWhenPassingZero() public {
        FolioToken t = _createWith(0, 0);
        assertEq(t.sniperWindowSeconds(), WINDOW);
        assertEq(t.sniperMaxEthPerWallet(), WALLET_CAP);
    }

    /// Both tightenings, and both actually enforced on the launch afterwards.
    function test_Creator_MayLengthenTheWindowAndLowerTheCap() public {
        FolioToken t = _createWith(WINDOW * 2, WALLET_CAP / 4);
        assertEq(t.sniperWindowSeconds(), WINDOW * 2);
        assertEq(t.sniperMaxEthPerWallet(), WALLET_CAP / 4);

        // The launch obeys the creator's numbers, not the platform's.
        uint256 before = alice.balance;
        _buyOn(t, alice, 1 ether, 0);
        assertEq(before - alice.balance, WALLET_CAP / 4, "the tighter cap did not bind");

        vm.warp(block.timestamp + WINDOW + 1);
        assertTrue(t.sniperWindowActive(), "the longer window ended at the platform default");
        vm.warp(block.timestamp + WINDOW + 1);
        assertFalse(t.sniperWindowActive());
        _assertSolventOn(t);
    }

    function test_Creator_MayTightenOnlyOneSideAtATime() public {
        FolioToken longer = _createWith(WINDOW * 3, 0);
        assertEq(longer.sniperWindowSeconds(), WINDOW * 3);
        assertEq(longer.sniperMaxEthPerWallet(), WALLET_CAP, "the cap should have been inherited");

        FolioToken stricter = _createWith(0, WALLET_CAP / 10);
        assertEq(stricter.sniperWindowSeconds(), WINDOW, "the window should have been inherited");
        assertEq(stricter.sniperMaxEthPerWallet(), WALLET_CAP / 10);
    }

    /// The whole point of the direction rule: no argument makes a launch easier
    /// to snipe than the platform decided.
    function test_Creator_CannotShortenTheWindow() public {
        vm.prank(creator);
        vm.expectRevert(FolioFactory.SniperWindowBelowDefault.selector);
        factory.createToken("Loose", "LSE", SUPPLY, 0, WINDOW - 1, 0);
    }

    function test_Creator_CannotRaiseThePerWalletCap() public {
        vm.prank(creator);
        vm.expectRevert(FolioFactory.SniperCapAboveDefault.selector);
        factory.createToken("Loose", "LSE", SUPPLY, 0, 0, WALLET_CAP + 1);
    }

    /// Zero is "inherit", not "switch off" — so there is no argument at all that
    /// removes a window the platform put there.
    function test_Creator_CannotSwitchTheWindowOff() public {
        FolioToken t = _createWith(0, 0);
        assertEq(t.sniperWindowSeconds(), WINDOW, "zero must not have disabled the window");
        assertTrue(t.sniperWindowActive());
    }

    function test_Creator_IsStillBoundByThePlatformCeilings() public {
        // Read before arming the cheatcode: an argument evaluated after
        // `expectRevert` is itself the "next call", and a view that returns
        // normally is what the cheatcode would then judge.
        uint16 tooLong = factory.MAX_SNIPER_WINDOW_SECONDS() + 1;
        uint256 tooTight = factory.MIN_SNIPER_MAX_ETH_PER_WALLET() - 1;

        vm.prank(creator);
        vm.expectRevert(FolioFactory.InvalidSniperWindow.selector);
        factory.createToken("TooLong", "TLG", SUPPLY, 0, tooLong, 0);

        // Below the floor is refused even though it is a tightening, because a
        // cap no buy can clear is a launch nobody can enter.
        vm.prank(creator);
        vm.expectRevert(FolioFactory.InvalidSniperCap.selector);
        factory.createToken("TooTight", "TTT", SUPPLY, 0, 0, tooTight);
    }

    /**
     * A platform that ships the mechanism off still lets a creator turn it on for
     * their own launch. With no default cap to be under, they name one outright —
     * the branch that would otherwise refuse them for exceeding zero.
     */
    function test_Creator_MayOptInWhenThePlatformHasItOff() public {
        CurveConfig memory off = _config();
        off.sniperWindowSeconds = 0;
        off.sniperMaxEthPerWallet = 0;
        vm.prank(owner);
        factory.setDefaultConfig(off);

        FolioToken t = _createWith(60, 0.02 ether);
        assertEq(t.sniperWindowSeconds(), 60);
        assertEq(t.sniperMaxEthPerWallet(), 0.02 ether);

        uint256 before = alice.balance;
        _buyOn(t, alice, 1 ether, 0);
        assertEq(before - alice.balance, 0.02 ether, "the opted-in cap did not bind");
        _assertSolventOn(t);
    }

    /// Turning the window on without naming the cap it needs is the one gap the
    /// two independent branches can still leave, and it is closed.
    function test_Creator_CannotOptInWithoutNamingACap() public {
        CurveConfig memory off = _config();
        off.sniperWindowSeconds = 0;
        off.sniperMaxEthPerWallet = 0;
        vm.prank(owner);
        factory.setDefaultConfig(off);

        vm.prank(creator);
        vm.expectRevert(FolioFactory.InvalidSniperCap.selector);
        factory.createToken("Halfway", "HLF", SUPPLY, 0, 60, 0);
    }

    /// The creator's numbers are what the launch is frozen to, so they are what
    /// `TokenCreated` has to carry — a watcher reading the platform default would
    /// have the wrong terms for this launch.
    function test_Creator_EmittedConfigIsTheEffectiveOne() public {
        vm.recordLogs();
        FolioToken t = _createWith(WINDOW * 2, WALLET_CAP / 2);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256(
            "TokenCreated(address,address,string,string,uint256,(uint256,uint256,uint256,uint16,uint16,uint16,uint256,address))"
        );
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != topic) continue;
            found = true;
            (,,, CurveConfig memory cfg) =
                abi.decode(logs[i].data, (string, string, uint256, CurveConfig));
            assertEq(cfg.sniperWindowSeconds, WINDOW * 2);
            assertEq(cfg.sniperMaxEthPerWallet, WALLET_CAP / 2);
            assertEq(cfg.sniperWindowSeconds, t.sniperWindowSeconds());
            assertEq(cfg.sniperMaxEthPerWallet, t.sniperMaxEthPerWallet());
        }
        assertTrue(found, "TokenCreated not emitted");
    }

    /// Tightening the window must not disturb the cap-and-threshold clamping the
    /// four-argument overload already does.
    function test_Creator_MayTightenTheReserveCapAndTheWindowTogether() public {
        vm.prank(creator);
        FolioToken t =
            FolioToken(factory.createToken("Both", "BTH", SUPPLY, 1 ether, WINDOW * 2, 0.01 ether));

        assertEq(t.maxReserveCap(), 1 ether);
        assertEq(t.graduationThreshold(), 1 ether, "the threshold should clamp to the cap");
        assertEq(t.sniperWindowSeconds(), WINDOW * 2);
        assertEq(t.sniperMaxEthPerWallet(), 0.01 ether);
        _assertSolventOn(t);
    }

    // -----------------------------------------------------------------------
    // Fuzz
    // -----------------------------------------------------------------------

    /// However much is sent, and whoever sends it, the amount that leaves the
    /// buyer's wallet never exceeds the cap while the window is open — and the
    /// quote always said so in advance.
    function testFuzz_SpendNeverExceedsTheCap(uint256 sent, uint256 actorSeed) public {
        sent = bound(sent, 1, 500 ether);
        address who = [alice, bob, carol, dave, eve][bound(actorSeed, 0, 4)];
        vm.deal(who, sent);

        (, uint256 quotedSpend,) = token.getBuyQuoteFor(sent, who);
        vm.assume(quotedSpend > 0);

        uint256 before = who.balance;
        vm.prank(who);
        token.buy{value: sent}(0);

        uint256 spent = before - who.balance;
        assertEq(spent, quotedSpend, "settlement spent something other than the quote");
        assertLe(spent, WALLET_CAP, "the cap did not hold");
        assertEq(token.sniperSpent(who), spent);
        _assertSolvent();
    }
}
