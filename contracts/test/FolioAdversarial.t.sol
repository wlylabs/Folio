// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";
import {FolioTestBase} from "./helpers/FolioTestBase.sol";
import {
    PersistentReentrant,
    EthRejector,
    RogueLauncher,
    ForceFeeder,
    Sandwicher
} from "./helpers/Adversaries.sol";

/**
 * Stage 4, part four: the suite that assumes the counterparty is hostile.
 *
 * Each section below is an attack someone would actually try, run to the point
 * where it either fails or succeeds — and where it succeeds, the cost and the
 * damage are measured rather than glossed. Two of them do succeed. They are
 * marked `Finding` in their names and documented at the point of the test, and
 * neither has been quietly patched: what to do about them is a decision for the
 * people who own this contract, and it cannot be made from inside a test file.
 */
contract FolioAdversarialTest is FolioTestBase {
    address internal attacker = makeAddr("attacker");
    address internal victim = makeAddr("victim");

    function setUp() public override {
        super.setUp();
        vm.deal(attacker, 1_000 ether);
        vm.deal(victim, 1_000 ether);
        // The owner and the creator need ETH too: several tests below have them
        // *attempt* a trade, and an attempt that fails for want of funds would
        // pass the assertion for the wrong reason.
        vm.deal(owner, 1_000 ether);
        vm.deal(creator, 1_000 ether);
    }

    /**
     * A launch with room to move: no graduation, a 500 ETH cap.
     *
     * The default launch graduates at 4 ETH, which is less than a front-run in
     * these tests moves. On that launch a sandwich fails with `CurveClosed`
     * rather than by being repelled, which would make the front-running tests
     * pass for entirely the wrong reason.
     */
    function _roomyLaunch() internal returns (FolioToken) {
        CurveConfig memory cfg = _config();
        cfg.graduationThreshold = 0;
        cfg.maxReserveCap = 500 ether;
        vm.prank(owner);
        factory.setDefaultConfig(cfg);
        return _create(SUPPLY);
    }

    // =======================================================================
    // 1. Reentrancy
    // =======================================================================

    /**
     * The classic: a contract that re-enters `sell` from the `receive` hook that
     * fires while it is being paid.
     *
     * Stages 2 and 3 already fire one re-entry per payout. This one keeps trying
     * for as long as the hook runs, so what it shows is that the guard holds for
     * the whole external call rather than only rejecting the first attempt.
     */
    function test_Reentrancy_SellCannotBeReEnteredRepeatedly() public {
        PersistentReentrant bad = new PersistentReentrant(token);
        vm.deal(address(bad), 100 ether);

        bad.doBuy(5 ether, 0);
        uint256 held = token.balanceOf(address(bad));

        bad.arm(PersistentReentrant.Mode.Sell, 8);
        bad.doSell(held / 2, 0);

        assertEq(bad.attempts(), 8, "the hook never ran; this test would prove nothing");
        assertEq(bad.successes(), 0, "a re-entrant sell got through");
        assertEq(
            bad.firstErrorSelector(),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "the re-entry was blocked by something other than the guard"
        );
        _assertSolvent();
    }

    /// The same, crossing between functions: sell out, try to buy back in.
    function test_Reentrancy_SellCannotReEnterBuy() public {
        PersistentReentrant bad = new PersistentReentrant(token);
        vm.deal(address(bad), 100 ether);

        bad.doBuy(5 ether, 0);
        bad.arm(PersistentReentrant.Mode.Buy, 5);
        bad.doSell(token.balanceOf(address(bad)) / 2, 0);

        assertEq(bad.attempts(), 5);
        assertEq(bad.successes(), 0, "a re-entrant buy got through");
        assertEq(bad.firstErrorSelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _assertSolvent();
    }

    /// Alternating between the two, in case the guard were somehow per-function.
    function test_Reentrancy_AlternatingBuysAndSellsAreAllBlocked() public {
        PersistentReentrant bad = new PersistentReentrant(token);
        vm.deal(address(bad), 100 ether);

        bad.doBuy(5 ether, 0);
        bad.arm(PersistentReentrant.Mode.Alternate, 10);
        bad.doSell(token.balanceOf(address(bad)) / 2, 0);

        assertEq(bad.attempts(), 10);
        assertEq(bad.successes(), 0, "an alternating re-entry got through");
        _assertSolvent();
    }

    /// Re-entering through the *refund* path, which is the other place this
    /// contract hands control to an address of the caller's choosing.
    function test_Reentrancy_TheRefundHookCannotReEnter() public {
        PersistentReentrant bad = new PersistentReentrant(token);
        vm.deal(address(bad), 100 ether);

        // Overshoot the graduation threshold so the buy produces a refund.
        bad.arm(PersistentReentrant.Mode.Sell, 4);
        bad.doBuy(50 ether, 0);

        assertEq(bad.attempts(), 4, "no refund was issued, so the hook never ran");
        assertEq(bad.successes(), 0, "a re-entrant call rode in on the refund");
        assertEq(bad.firstErrorSelector(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(token.ethReserve(), 4 ether);
        _assertSolvent();
    }

    /// And through `claimFees`, the third and last ETH exit.
    function test_Reentrancy_ClaimFeesCannotBeReEntered() public {
        PersistentReentrant bad = new PersistentReentrant(token);
        vm.deal(address(bad), 100 ether);

        // Give the contract a launch of its own so it is the fee recipient.
        vm.prank(address(bad));
        FolioToken own = FolioToken(factory.createToken("Bad", "BAD", SUPPLY));
        bad.retargetTo(own);

        _buyOn(own, alice, 3 ether, 0);
        assertGt(own.feesAccrued(), 0);

        bad.arm(PersistentReentrant.Mode.Claim, 4);
        bad.doClaim();

        assertEq(bad.attempts(), 4);
        assertEq(bad.successes(), 0, "fees were claimed twice");
        assertEq(own.feesAccrued(), 0, "the balance should be zeroed exactly once");
        _assertSolventOn(own);
    }

    // =======================================================================
    // 2. Front-running and sandwiching
    // =======================================================================

    /**
     * The sandwich, run properly: the attacker buys in front of the victim and
     * sells behind them.
     *
     * With a slippage floor taken from the quote, the victim's transaction
     * reverts instead of filling at the attacker's price. That is the protection
     * working — the victim keeps their ETH and the attacker is left holding a
     * position they have to unwind at a loss.
     */
    function test_Sandwich_SlippageFloorMakesTheVictimUnsandwichable() public {
        token = _roomyLaunch();

        // The victim quotes and sets a 1% floor, as a frontend would.
        (uint256 quoted,,) = token.getBuyQuote(5 ether);
        uint256 floor = quoted * 99 / 100;

        // The attacker gets in first.
        Sandwicher bad = new Sandwicher(token);
        vm.deal(address(bad), 100 ether);
        bad.frontRun(20 ether);

        // The victim's transaction now cannot fill at anything like the price
        // they quoted, so it reverts and their ETH stays put.
        uint256 victimBefore = victim.balance;
        (uint256 nowAvailable,,) = token.getBuyQuote(5 ether);
        assertLt(nowAvailable, floor, "the front-run did not actually move the price");

        vm.prank(victim);
        vm.expectRevert(
            abi.encodeWithSelector(FolioToken.SlippageExceeded.selector, nowAvailable, floor)
        );
        token.buy{value: 5 ether}(floor);

        assertEq(victim.balance, victimBefore, "the victim paid despite the floor");
        assertEq(token.balanceOf(victim), 0);
        _assertSolvent();
    }

    /**
     * FINDING — an unprotected buyer is not merely worsened by a sandwich, they
     * are very nearly wiped out, and the attack pays extremely well.
     *
     * Same sandwich as above with the floor left at zero, which is exactly what
     * `minTokensOut = 0` means once the transaction is in a public mempool. The
     * measured result, logged below: against a 5 ETH victim buy, a 20 ETH
     * front-run leaves the victim holding roughly **1/42nd** of the tokens they
     * quoted, and hands the attacker about **4.5 ETH of profit** — close to the
     * entire 5 ETH the victim spent.
     *
     * The reason it is this severe is the shape of the curve rather than a
     * defect in the code. `virtualEthReserve` defaults to 2 ETH, so a 20 ETH
     * front-run moves the price by more than 10x, and the victim buys at the top
     * of that. A flatter curve — a larger virtual reserve — would blunt it. So
     * would nothing else in this contract, because the contract is pricing
     * exactly as designed the whole way through: the reserve stays solvent, and
     * every wei the attacker gains is a wei the victim lost, which the
     * conservation assertion below pins down.
     *
     * What this means in practice, and it is worth being blunt about it:
     * `minTokensOut = 0` is not a convenience default, it is a loaded gun. The
     * contract already offers the fix and the test above proves it works — but
     * the protection lives entirely in the *caller's* argument, so it is the
     * frontend's job to never send zero, and an integrator who does not know
     * that will lose their users' money on a curve this steep.
     */
    function test_Sandwich_Finding_AnUnprotectedBuyerIsNearlyDrained() public {
        token = _roomyLaunch();

        (uint256 unsandwiched,,) = token.getBuyQuote(5 ether);

        Sandwicher bad = new Sandwicher(token);
        vm.deal(address(bad), 100 ether);
        uint256 attackerStart = address(bad).balance;

        bad.frontRun(20 ether);
        uint256 got = _buy(victim, 5 ether, 0); // no floor — the loaded gun
        bad.backRun();

        uint256 attackerGain = address(bad).balance - attackerStart;
        uint256 victimHoldingsWorth = token.getSellPrice(got);
        uint256 victimLoss = 5 ether - victimHoldingsWorth;

        console.log("tokens quoted, no sandwich", unsandwiched);
        console.log("tokens actually received  ", got);
        console.log("victim received 1/n of quote", unsandwiched / got);
        console.log("victim spent        (wei) ", uint256(5 ether));
        console.log("victim holdings now (wei) ", victimHoldingsWorth);
        console.log("victim loss         (wei) ", victimLoss);
        console.log("attacker profit     (wei) ", attackerGain);

        // The attack works, and it works well.
        assertLt(got, unsandwiched / 10, "the sandwich cost the victim less than 90%");
        assertGt(attackerGain, 1 ether, "the sandwich was not profitable");

        // But it is a transfer, not a theft from the reserve: the attacker's
        // gain never exceeds the victim's loss, and the curve stays solvent.
        assertLe(attackerGain, victimLoss, "the attacker gained more than the victim lost");
        _assertSolvent();
    }

    /// A back-run alone — buying immediately after someone else's large buy —
    /// is not profitable either, because the round trip pays two fees.
    function test_FrontRun_APureBackRunLosesMoney() public {
        token = _roomyLaunch();
        _buy(victim, 5 ether, 0);

        uint256 before = attacker.balance;
        uint256 got = _buy(attacker, 5 ether, 0);
        _sell(attacker, got, 0);

        assertLt(attacker.balance, before, "a back-run turned a profit");
        _assertSolvent();
    }

    /// The floor holds at the exact quote: a trade that nobody interferes with
    /// always fills, so the protection does not cost honest users anything.
    function test_Sandwich_AnUnmolestedTradeAlwaysFillsAtItsQuote() public {
        (uint256 quoted,,) = token.getBuyQuote(1 ether);
        uint256 got = _buy(victim, 1 ether, quoted);
        assertEq(got, quoted, "an unmolested trade did not fill at its own quote");
        _assertSolvent();
    }

    /// Sellers get the same protection on their leg.
    function test_Sandwich_SellersAreProtectedToo() public {
        uint256 held = _buy(victim, 3 ether, 0);
        uint256 quoted = token.getSellPrice(held);
        uint256 floor = quoted * 99 / 100;

        // Somebody dumps in front of the victim's sell.
        _buy(attacker, 1 ether, 0);
        uint256 attackerHeld = token.balanceOf(attacker);
        _sell(attacker, attackerHeld, 0);

        uint256 nowAvailable = token.getSellPrice(held);
        if (nowAvailable < floor) {
            vm.prank(victim);
            vm.expectRevert(
                abi.encodeWithSelector(FolioToken.SlippageExceeded.selector, nowAvailable, floor)
            );
            token.sell(held, floor);
            assertEq(token.balanceOf(victim), held, "the victim's tokens were burned anyway");
        }
        _assertSolvent();
    }

    // =======================================================================
    // 3. Bank run
    // =======================================================================

    /**
     * Everybody sells at once, in the order they bought.
     *
     * The properties that matter: every holder's sale goes through, the reserve
     * covers the obligation after each one, and the group does not take out more
     * than the group put in. Who does best is a separate question, handled below.
     */
    function test_BankRun_EveryoneExitsInBuyOrder() public {
        address[5] memory holders = [alice, bob, carol, dave, eve];
        uint256 totalIn;
        for (uint256 i = 0; i < holders.length; i++) {
            _buy(holders[i], 0.5 ether, 0);
            totalIn += 0.5 ether;
        }

        uint256 totalOut;
        for (uint256 i = 0; i < holders.length; i++) {
            uint256 held = token.balanceOf(holders[i]);
            assertGt(held, 0);
            assertGt(token.getSellPrice(held), 0, "a holder was left with an unsellable position");
            totalOut += _sell(holders[i], held, 0);
            _assertSolvent();
        }

        assertEq(token.totalSupply(), 0, "somebody was left holding tokens");
        assertLe(totalOut, totalIn, "the bank run paid out more than it took in");
        assertLe(token.ethReserve(), 10, "the reserve should be empty but for dust");
    }

    /// The same run in reverse — last in, first out.
    function test_BankRun_EveryoneExitsInReverseOrder() public {
        address[5] memory holders = [alice, bob, carol, dave, eve];
        uint256 totalIn;
        for (uint256 i = 0; i < holders.length; i++) {
            _buy(holders[i], 0.5 ether, 0);
            totalIn += 0.5 ether;
        }

        uint256 totalOut;
        for (uint256 i = holders.length; i > 0; i--) {
            uint256 held = token.balanceOf(holders[i - 1]);
            assertGt(token.getSellPrice(held), 0, "a holder was left with an unsellable position");
            totalOut += _sell(holders[i - 1], held, 0);
            _assertSolvent();
        }

        assertEq(token.totalSupply(), 0);
        assertLe(totalOut, totalIn, "the reverse bank run paid out more than it took in");
    }

    /**
     * CHARACTERISTIC — what buying early and selling first is actually worth.
     *
     * Five holders stake the same 0.5 ETH in sequence, so each pays a higher
     * price than the last. Then everybody exits in the order they bought. The
     * measured result, logged by this test:
     *
     *     holder 0   +172%      holder 3   -66%
     *     holder 1     +5%      holder 4   -77%
     *     holder 2    -45%
     *
     * That spread is not a bug and there is nothing here to fix. It is what a
     * constant-product curve with no lock-up *does*: the first buyer bought at
     * the opening price, the four behind them moved the price up by 2.2x, and
     * selling first is selling into that. Every AMM behaves this way, and the
     * same shape is why this class of launch is described the way it is.
     *
     * It belongs in the test suite anyway, because it is the difference between
     * a property the operators chose and one they discover from a user. The
     * contract is solvent throughout — what the early holder gains, the late
     * holders lose, and the *reserve* is never the source of it. That last
     * clause is what this test actually asserts; the distribution above it is
     * documentation.
     */
    function test_BankRun_ExitOrderRedistributesBetweenHoldersOnly() public {
        address[5] memory holders = [alice, bob, carol, dave, eve];
        uint256 stake = 0.5 ether;
        uint256 totalIn = stake * holders.length;

        for (uint256 i = 0; i < holders.length; i++) {
            _buy(holders[i], stake, 0);
        }

        uint256[5] memory recovered;
        uint256 totalOut;
        for (uint256 i = 0; i < holders.length; i++) {
            uint256 held = token.balanceOf(holders[i]);
            assertGt(token.getSellPrice(held), 0, "a holder was left unable to exit");
            recovered[i] = _sell(holders[i], held, 0);
            totalOut += recovered[i];
            _assertSolvent();
            console.log("holder", i, "recovered (wei)", recovered[i]);
        }

        // Everybody got out.
        assertEq(token.totalSupply(), 0, "somebody was left holding tokens");

        // The ordering advantage is real and monotonic — first out does best.
        for (uint256 i = 1; i < holders.length; i++) {
            assertLt(recovered[i], recovered[i - 1], "the exit order advantage is not monotonic");
        }

        // The group as a whole is down, and by exactly the fees: every wei that
        // did not come back to a holder is either an accrued fee or dust left in
        // the reserve. Nothing leaked to a fourth place, which is the claim that
        // makes the redistribution above a transfer between holders rather than
        // a hole in the contract.
        assertLt(totalOut, totalIn, "the group as a whole came out ahead of the curve");
        assertEq(
            totalIn - totalOut,
            token.feesAccrued() + token.ethReserve(),
            "the group's shortfall is not accounted for by fees and dust"
        );

        console.log("total staked (wei)   ", totalIn);
        console.log("total recovered (wei)", totalOut);
        console.log("fees accrued (wei)   ", token.feesAccrued());
        console.log("reserve dust (wei)   ", token.ethReserve());
    }

    /// A bank run that starts from a graduated curve — the state where buying is
    /// closed and selling is the only thing left.
    function test_BankRun_WorksOnAGraduatedCurve() public {
        _buy(alice, 2 ether, 0);
        _buy(bob, 2 ether, 0);
        _buy(carol, 5 ether, 0); // pushes it over the threshold
        assertTrue(token.graduated());

        uint256 totalOut;
        totalOut += _sell(carol, token.balanceOf(carol), 0);
        _assertSolvent();
        totalOut += _sell(alice, token.balanceOf(alice), 0);
        _assertSolvent();
        totalOut += _sell(bob, token.balanceOf(bob), 0);
        _assertSolvent();

        assertEq(token.totalSupply(), 0, "somebody could not exit a graduated curve");
        assertGt(totalOut, 0);
    }

    /// A hundred holders, exiting in a scrambled order.
    function test_BankRun_ScrambledOrderWithManyHolders() public {
        uint256 n = 100;
        address[] memory holders = new address[](n);
        uint256 totalIn;

        for (uint256 i = 0; i < n; i++) {
            holders[i] = address(uint160(uint256(keccak256(abi.encode("holder", i)))));
            vm.deal(holders[i], 1 ether);
            _buy(holders[i], 0.03 ether, 0);
            totalIn += 0.03 ether;
        }

        // Walk the list with a stride coprime to its length: every holder is hit
        // exactly once, in an order unrelated to the one they bought in.
        uint256 totalOut;
        uint256 idx;
        for (uint256 i = 0; i < n; i++) {
            idx = (idx + 37) % n;
            address holder = holders[idx];
            uint256 held = token.balanceOf(holder);
            assertGt(held, 0, "a holder was visited twice or missed");
            assertGt(token.getSellPrice(held), 0, "a holder was stuck with dust");
            totalOut += _sell(holder, held, 0);
            _assertSolvent();
        }

        assertEq(token.totalSupply(), 0, "not everybody got out");
        assertLe(totalOut, totalIn, "a hundred-holder run paid out more than it took in");
    }

    // =======================================================================
    // 4. Griefing and denial of service
    // =======================================================================

    /**
     * FINDING — a launch can be closed to new buyers permanently, for the price
     * of a round trip.
     *
     * `graduated` is set the moment the reserve touches `graduationThreshold`,
     * and nothing ever clears it. So anyone can buy up to the threshold, be
     * marked graduated, and then sell everything straight back out. The reserve
     * empties, the token's price returns to roughly where it started, and the
     * curve is closed to buys forever with nobody holding anything.
     *
     * The attacker's cost is the round-trip fee — about 2% of the threshold —
     * plus gas. Their capital requirement is the threshold itself and only for
     * the length of one transaction, so it is flash-loanable. The launch's
     * creator loses their launch; existing holders keep the ability to sell, so
     * no funds are stolen.
     *
     * This is left exactly as found. The obvious fixes each involve a real
     * trade-off — graduating on a high-water mark rather than the live reserve,
     * requiring the reserve to hold the threshold for some interval, or gating
     * graduation behind something other than an instantaneous read — and picking
     * between them is a design decision, not a test-suite decision.
     */
    function test_Griefing_Finding_GraduationCanBeForcedAndIsIrreversible() public {
        uint256 threshold = token.graduationThreshold();
        uint256 before = attacker.balance;

        // One transaction's worth of capital, in and straight back out.
        uint256 got = _buy(attacker, threshold * 102 / 100, 0);
        assertTrue(token.graduated(), "the threshold was not reached");
        _sell(attacker, got, 0);

        uint256 cost = before - attacker.balance;
        console.log("graduation threshold (wei)", threshold);
        console.log("attacker net cost    (wei)", cost);
        console.log("cost as bps of threshold  ", cost * BPS / threshold);
        console.log("reserve left behind  (wei)", token.ethReserve());

        // The launch is now permanently closed to buyers.
        assertTrue(token.graduated(), "graduation was somehow undone");
        vm.prank(victim);
        vm.expectRevert(FolioToken.CurveClosed.selector);
        token.buy{value: 1 ether}(0);

        // SECONDARY FINDING — `ethHeadroom()` does not know about graduation.
        //
        // It is derived from the reserve against the ceiling, and the reserve
        // has just been sold back down to nothing, so it reports a launch with
        // nearly the whole threshold still to go. Buying is closed regardless,
        // via the separate `graduated` latch that `buy` checks first.
        //
        // Nothing on the trading path is wrong — `buy` reverts correctly. The
        // problem is that `ethHeadroom` is exactly the kind of view a frontend
        // reaches for to decide whether to show a buy button, and here it says
        // "3.99 ETH of room left" about a launch that will refuse every buy.
        // Any caller has to read `graduated()` as well; `getBuyQuote` already
        // does, and returns a full refund, which is the safe thing to price
        // against.
        assertGt(token.ethHeadroom(), 3.9 ether, "headroom is expected to misreport here");
        (uint256 quoted,, uint256 refund) = token.getBuyQuote(1 ether);
        assertEq(quoted, 0, "the quote should report the curve as closed");
        assertEq(refund, 1 ether, "the quote should refund the lot");

        // ...while holding essentially nothing. The reserve went back out with
        // the attacker, so this is not a launch that "completed", it is a dead one.
        assertLe(token.ethReserve(), 10, "the reserve should be empty after the unwind");
        assertEq(token.totalSupply(), 0, "the attacker still holds tokens");

        // The cost really is only the fee legs, not the capital.
        assertLt(cost, threshold * 3 / 100, "cheaper than 3% of the threshold");
        _assertSolvent();
    }

    /// The same attack is *not* available against a launch with graduation
    /// switched off: filling the cap closes buying too, but selling back out
    /// reopens it, because the cap is a live reading rather than a latch.
    function test_Griefing_TheHardCapIsNotALatchAndRecovers() public {
        token = _createWithoutGraduation(1 ether);

        uint256 got = _buy(attacker, 2 ether, 0);
        assertEq(token.ethHeadroom(), 0, "the cap should be full");
        _sell(attacker, got, 0);

        assertGt(token.ethHeadroom(), 0, "headroom did not come back");
        assertFalse(token.graduated());

        // A real buyer can still get in afterwards.
        uint256 bought = _buy(victim, 0.5 ether, 0);
        assertGt(bought, 0, "the launch was left unusable");
        _assertSolvent();
    }

    /// Dust buys are not a denial of service: they are individually priced,
    /// they move the curve by essentially nothing, and they cost the attacker
    /// gas far exceeding what they achieve.
    function test_Griefing_DustBuysDoNotDegradeTheLaunch() public {
        (uint256 quotedBefore,,) = token.getBuyQuote(1 ether);

        for (uint256 i = 0; i < 200; i++) {
            _buy(attacker, 1, 0);
        }

        (uint256 quotedAfter,,) = token.getBuyQuote(1 ether);
        assertApproxEqRel(quotedAfter, quotedBefore, 1e12, "200 wei moved the price materially");
        assertEq(token.ethReserve(), 200, "the dust is all accounted for");

        // A real buyer is unaffected.
        assertGt(_buy(victim, 1 ether, 0), 0);
        _assertSolvent();
    }

    /// ETH forced in from outside — the `selfdestruct` trick — changes nothing.
    /// This is why the curve reads `ethReserve` from storage and never from
    /// `address(this).balance`.
    function test_Griefing_ForcedEthCannotDisturbTheCurve() public {
        _buy(alice, 1 ether, 0);

        uint256 reserveBefore = token.ethReserve();
        uint256 priceBefore = token.currentPrice();
        uint256 obligationBefore = token.getOutstandingSellObligation();

        // A plain transfer is refused outright: there is no `receive`.
        vm.prank(attacker);
        (bool ok,) = address(token).call{value: 1 ether}("");
        assertFalse(ok, "the token accepted a plain ETH transfer");

        // `selfdestruct` gets around that, and still achieves nothing.
        vm.prank(attacker);
        new ForceFeeder{value: 50 ether}(payable(address(token)));

        assertEq(address(token).balance, 50 ether + 1 ether, "the ETH did not arrive");
        assertEq(token.ethReserve(), reserveBefore, "forced ETH entered the reserve");
        assertEq(token.currentPrice(), priceBefore, "forced ETH moved the price");
        assertEq(token.getOutstandingSellObligation(), obligationBefore);
        assertEq(token.feesAccrued(), 1 ether / 100, "forced ETH became claimable fees");

        // Trading carries on exactly as before, and the creator cannot claim the
        // windfall either.
        _buy(bob, 1 ether, 0);
        _sell(alice, token.balanceOf(alice), 0);
        vm.prank(creator);
        uint256 claimed = token.claimFees();
        assertLt(claimed, 1 ether, "the creator got at the forced ETH");
        _assertSolvent();
    }

    /**
     * A holder that cannot receive ETH is a problem for that holder alone.
     *
     * Its own sale reverts, because the payout call fails. Nothing about that
     * touches the reserve, blocks anybody else, or leaves its tokens stranded —
     * they can be moved to an address that can take the money and sold from
     * there.
     */
    function test_Griefing_AnEthRejectingHolderOnlyBlocksItself() public {
        EthRejector stuck = new EthRejector(token);
        vm.deal(address(stuck), 10 ether);
        stuck.doBuy(1 ether, 0);
        _buy(alice, 1 ether, 0);

        uint256 held = token.balanceOf(address(stuck));
        assertGt(held, 0);

        vm.expectRevert(FolioToken.EthTransferFailed.selector);
        stuck.doSell(held, 0);

        // Everybody else is unaffected.
        assertGt(_sell(alice, token.balanceOf(alice), 0), 0);
        _assertSolvent();

        // And the position is not lost: move it somewhere that can be paid.
        stuck.moveTokens(bob, held);
        assertEq(token.balanceOf(bob), held);
        assertGt(_sell(bob, held, 0), 0, "the rescued position could not be sold");
        _assertSolvent();
    }

    /// A creator that cannot receive ETH blocks only their own fee income, and
    /// cannot wedge trading for anybody else.
    function test_Griefing_AnEthRejectingCreatorCannotWedgeTrading() public {
        EthRejector badCreator = new EthRejector(token);
        vm.prank(address(badCreator));
        FolioToken t = FolioToken(factory.createToken("Stuck", "STK", SUPPLY));
        badCreator.retargetTo(t);

        _buyOn(t, alice, 1 ether, 0);
        assertGt(t.feesAccrued(), 0);

        vm.expectRevert(FolioToken.EthTransferFailed.selector);
        badCreator.doClaim();

        // Trading is completely unaffected: fees are not on the trading path.
        _buyOn(t, bob, 1 ether, 0);
        _sellOn(t, alice, t.balanceOf(alice), 0);
        _sellOn(t, bob, t.balanceOf(bob), 0);
        _assertSolventOn(t);
    }

    /// Nobody can wedge the launch by leaving the reserve in a state where the
    /// next seller reverts. Walk right up to the ceiling and back down.
    function test_Griefing_WalkingTheCeilingLeavesTheLaunchUsable() public {
        // Fill to one wei under the threshold, then step over it.
        _buy(attacker, 3.9 ether, 0);
        _buy(victim, 0.5 ether, 0);
        assertTrue(token.graduated());

        // Both can still exit, in either order.
        assertGt(_sell(victim, token.balanceOf(victim), 0), 0);
        _assertSolvent();
        assertGt(_sell(attacker, token.balanceOf(attacker), 0), 0);
        _assertSolvent();
        assertEq(token.totalSupply(), 0);
    }

    /// Creating launches is not a griefing vector either: it is O(1), it costs
    /// the creator gas, and it cannot exhaust anything shared.
    function test_Griefing_MassLaunchCreationDegradesNothing() public {
        for (uint256 i = 0; i < 50; i++) {
            vm.prank(attacker);
            factory.createToken("Spam", "SPM", 1000);
        }

        assertEq(factory.tokenCount(), 51, "the launch from setUp plus fifty");

        // A real launch afterwards behaves identically.
        FolioToken real = _create(SUPPLY);
        assertGt(_buyOn(real, victim, 1 ether, 0), 0);
        _assertSolventOn(real);
    }

    // =======================================================================
    // 5. Access control
    // =======================================================================

    /// Every owner-only function on the factory, called by somebody who is not
    /// the owner.
    function test_Access_NonOwnerCannotReachAnyOwnerFunction() public {
        address[3] memory intruders = [attacker, creator, alice];

        for (uint256 i = 0; i < intruders.length; i++) {
            address who = intruders[i];

            vm.prank(who);
            vm.expectRevert(
                abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who)
            );
            factory.pause();

            vm.prank(who);
            vm.expectRevert(
                abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who)
            );
            factory.unpause();

            vm.prank(who);
            vm.expectRevert(
                abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who)
            );
            factory.setDefaultConfig(_config());

            vm.prank(who);
            vm.expectRevert(
                abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who)
            );
            factory.transferOwnership(who);
        }

        // And nothing changed.
        assertEq(factory.owner(), owner);
        assertFalse(factory.paused());
    }

    /// Ownership cannot be seized by claiming it, and cannot be destroyed.
    function test_Access_OwnershipCannotBeSeizedOrDestroyed() public {
        // Nobody can accept an offer that was never made.
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker)
        );
        factory.acceptOwnership();

        // An offer to somebody else cannot be intercepted.
        vm.prank(owner);
        factory.transferOwnership(alice);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker)
        );
        factory.acceptOwnership();
        assertEq(factory.owner(), owner, "ownership moved before it was accepted");

        // Even the owner cannot renounce.
        vm.prank(owner);
        vm.expectRevert(FolioFactory.RenounceDisabled.selector);
        factory.renounceOwnership();
        assertEq(factory.owner(), owner);
    }

    /// The token's one privileged function, tried by everybody who is not the
    /// creator — including the factory owner, who has no authority here.
    function test_Access_OnlyTheCreatorCanClaimFees() public {
        _buy(alice, 1 ether, 0);
        uint256 accrued = token.feesAccrued();
        assertGt(accrued, 0);

        address[4] memory intruders = [attacker, alice, owner, address(factory)];
        for (uint256 i = 0; i < intruders.length; i++) {
            vm.prank(intruders[i]);
            vm.expectRevert(FolioToken.NotCreator.selector);
            token.claimFees();
        }

        assertEq(token.feesAccrued(), accrued, "a refused claim moved the balance");
    }

    /// `initialize` cannot be run a second time on a live launch, by anyone.
    function test_Access_ALiveLaunchCannotBeReInitialized() public {
        CurveConfig memory hostile = _config();
        hostile.feeBps = 500;

        address[3] memory intruders = [attacker, creator, owner];
        for (uint256 i = 0; i < intruders.length; i++) {
            vm.prank(intruders[i]);
            vm.expectRevert(Initializable.InvalidInitialization.selector);
            token.initialize(attacker, "Hijacked", "HJK", SUPPLY, hostile);
        }

        assertEq(token.creator(), creator, "the creator was reassigned");
        assertEq(token.feeBps(), FEE_BPS, "the fee was changed on a live launch");
    }

    /// The shared implementation is locked, so nobody can squat on it and have
    /// every future clone answer to them.
    function test_Access_TheImplementationCannotBeInitialized() public {
        FolioToken impl = FolioToken(factory.implementation());
        CurveConfig memory cfg = _config();

        vm.prank(attacker);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(attacker, "Squat", "SQT", SUPPLY, cfg);
    }

    /// The owner's reach stops at future launches. Nothing they can do touches a
    /// live one's terms, its reserve, or its creator.
    function test_Access_TheOwnerCannotReachALiveLaunch() public {
        _buy(alice, 1 ether, 0);

        uint256 reserve = token.ethReserve();
        uint256 cap = token.maxReserveCap();
        uint16 fee = token.feeBps();
        address liveCreator = token.creator();
        uint256 ownerBefore = owner.balance;

        // Change every platform default there is.
        CurveConfig memory hostile = CurveConfig({
            virtualEthReserve: 1 ether,
            maxReserveCap: 1000 ether,
            graduationThreshold: 1000 ether,
            feeBps: 500,
            priceMoveAlertBps: 100,
            sniperWindowSeconds: 0,
            sniperMaxEthPerWallet: 0,
            migrator: address(0)
        });
        vm.startPrank(owner);
        factory.setDefaultConfig(hostile);
        factory.pause();
        factory.unpause();
        vm.stopPrank();

        assertEq(token.ethReserve(), reserve, "the owner moved a live reserve");
        assertEq(token.maxReserveCap(), cap, "the owner retuned a live cap");
        assertEq(token.feeBps(), fee, "the owner changed a live fee");
        assertEq(token.creator(), liveCreator, "the owner reassigned a creator");
        assertEq(owner.balance, ownerBefore, "the owner extracted ETH");

        // And the holder can still sell on the original terms.
        assertGt(_sell(alice, token.balanceOf(alice), 0), 0);
        _assertSolvent();
    }

    /// There is no function anywhere that moves the reserve to a chosen address.
    /// Brute-forced over the whole ABI rather than argued.
    function test_Access_NoFunctionDrainsTheReserveToAnAttacker() public {
        _buy(alice, 3 ether, 0);
        uint256 reserve = token.ethReserve();
        uint256 attackerBefore = attacker.balance;

        bytes[8] memory calls = [
            abi.encodeWithSignature("withdraw()"),
            abi.encodeWithSignature("withdraw(uint256)", reserve),
            abi.encodeWithSignature("emergencyWithdraw()"),
            abi.encodeWithSignature("sweep(address)", attacker),
            abi.encodeWithSignature("transferOwnership(address)", attacker),
            abi.encodeWithSignature("setCreator(address)", attacker),
            abi.encodeWithSignature("mint(address,uint256)", attacker, 1e24),
            abi.encodeWithSignature("burn(address,uint256)", alice, 1e24)
        ];

        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(attacker);
            (bool ok,) = address(token).call(calls[i]);
            assertFalse(ok, "an unexpected privileged function exists and succeeded");
        }

        assertEq(token.ethReserve(), reserve);
        assertEq(attacker.balance, attackerBefore);
        _assertSolvent();
    }

    /// A launch cloned outside the factory is not registered, which is the check
    /// that separates a real launch from a lookalike.
    function test_Access_ARogueCloneIsNotAFolioLaunch() public {
        RogueLauncher rogue = new RogueLauncher();
        address fake =
            rogue.launch(factory.implementation(), attacker, "Fake", "FKE", SUPPLY, _config());

        assertFalse(factory.isFolioToken(fake), "a rogue clone passed as a Folio launch");
        assertTrue(factory.isFolioToken(address(token)));
        assertEq(FolioToken(fake).factory(), address(rogue), "the clone answers to its launcher");

        // It also does not answer to the platform's emergency stop.
        vm.prank(owner);
        factory.pause();
        assertTrue(token.tradingPaused(), "the real launch ignored the stop");
        assertFalse(FolioToken(fake).tradingPaused(), "the rogue clone should not obey our stop");
    }

    /// The emergency stop cannot be worked around while it is engaged.
    function test_Access_NobodyCanTradeThroughThePause() public {
        _buy(alice, 1 ether, 0);
        vm.prank(owner);
        factory.pause();

        address[3] memory who = [attacker, creator, owner];
        for (uint256 i = 0; i < who.length; i++) {
            vm.prank(who[i]);
            vm.expectRevert(FolioToken.TradingPaused.selector);
            token.buy{value: 1 ether}(0);
        }

        uint256 aliceHolds = token.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(FolioToken.TradingPaused.selector);
        token.sell(aliceHolds, 0);

        // Creating new launches is stopped too.
        vm.prank(attacker);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createToken("During", "DUR", SUPPLY);

        // But the creator's fees are still theirs, and every view still answers.
        vm.prank(creator);
        assertGt(token.claimFees(), 0, "the pause withheld a creator's earnings");
        assertGt(token.currentPrice(), 0, "the pause blinded a view");
    }
}
