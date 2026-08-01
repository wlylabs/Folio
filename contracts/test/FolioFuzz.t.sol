// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";
import {FolioTestBase} from "./helpers/FolioTestBase.sol";

/**
 * Stage 4, part two: stateless fuzzing of the pricing functions and of short
 * trade sequences.
 *
 * The division of labour with `FolioInvariant.t.sol` is deliberate. This file
 * fuzzes *inputs* — one function, a huge range of arguments, a fresh curve each
 * run. That one fuzzes *sequences* — long random call orders against one
 * long-lived curve. Overflow and unexpected-revert bugs live in the first;
 * ordering and accumulation bugs live in the second.
 *
 * Every test here bounds its inputs to the range the contract will actually see
 * in production and then goes some way past it, rather than fuzzing the full
 * `uint256` domain and rejecting almost every run. A fuzz test that discards
 * 99% of its cases is a fuzz test with 5 effective runs.
 */
contract FolioFuzzTest is FolioTestBase {
    /// Comfortably more ETH than any of these tests can spend.
    uint256 internal constant DEEP_POCKETS = 10_000_000 ether;

    function setUp() public override {
        super.setUp();
        vm.deal(alice, DEEP_POCKETS);
        vm.deal(bob, DEEP_POCKETS);
        vm.deal(carol, DEEP_POCKETS);
    }

    // =======================================================================
    // getBuyPrice: the reverse quote
    // =======================================================================

    /**
     * `getBuyPrice` must answer for every token amount below the curve's
     * inventory, and refuse — cleanly, with its own error — at or above it.
     *
     * The whole domain is fuzzed, not a bounded slice: the point of this one is
     * that no input anywhere in `uint256` produces an arithmetic panic instead of
     * an answer or a named revert.
     */
    function testFuzz_GetBuyPrice_AnswersOrRevertsCleanly(uint256 tokenAmount) public {
        uint256 inventory = token.curveTokenReserve();

        if (tokenAmount >= inventory) {
            vm.expectRevert(FolioToken.ExceedsCurveInventory.selector);
            token.getBuyPrice(tokenAmount);
            return;
        }

        uint256 cost = token.getBuyPrice(tokenAmount);
        if (tokenAmount == 0) {
            assertEq(cost, 0, "zero tokens must be free");
        } else {
            assertGt(cost, 0, "a non-zero purchase must cost something");
        }
    }

    /// The same, on a curve that has already been moved by real trades — the
    /// asymptote is at a different place once inventory has been issued.
    function testFuzz_GetBuyPrice_AnswersOrRevertsCleanlyMidCurve(uint256 seed, uint256 tokenAmount)
        public
    {
        _buy(alice, bound(seed, 1, 3.9 ether), 0);
        uint256 inventory = token.curveTokenReserve();

        if (tokenAmount >= inventory) {
            vm.expectRevert(FolioToken.ExceedsCurveInventory.selector);
            token.getBuyPrice(tokenAmount);
        } else if (tokenAmount > 0) {
            assertGt(token.getBuyPrice(tokenAmount), 0);
        }
    }

    /// Buying more must never cost less. Checked across the whole priceable
    /// range, including the steep part near the asymptote.
    function testFuzz_GetBuyPrice_IsMonotonic(uint256 a, uint256 b) public view {
        uint256 inventory = token.curveTokenReserve();
        a = bound(a, 0, inventory - 2);
        b = bound(b, a, inventory - 1);

        assertGe(token.getBuyPrice(b), token.getBuyPrice(a), "a bigger buy priced cheaper");
    }

    /// The quote is a floor on what the money actually buys: send exactly what
    /// `getBuyPrice` asks for and you receive at least what you asked for.
    /// This is the property that makes the number safe to put in a wallet.
    function testFuzz_GetBuyPrice_IsEnoughToBuyThatMany(uint256 tokenAmount) public {
        tokenAmount = bound(tokenAmount, 1, 100_000 * UNIT);
        uint256 cost = token.getBuyPrice(tokenAmount);
        vm.assume(cost <= 3.9 ether); // stay clear of the ceiling clamp

        uint256 got = _buy(alice, cost, 0);
        assertGe(got, tokenAmount, "the quoted price bought fewer tokens than quoted");
        _assertSolvent();
    }

    // =======================================================================
    // getSellPrice: the forward quote
    // =======================================================================

    /// `getSellPrice` answers for anything inside the circulating supply and
    /// refuses cleanly above it — again across the entire `uint256` domain.
    function testFuzz_GetSellPrice_AnswersOrRevertsCleanly(uint256 seed, uint256 tokenAmount)
        public
    {
        _buy(alice, bound(seed, 1, 3.9 ether), 0);
        uint256 circulating = token.tokensSold();

        if (tokenAmount > circulating) {
            vm.expectRevert(FolioToken.ExceedsCirculating.selector);
            token.getSellPrice(tokenAmount);
            return;
        }

        uint256 payout = token.getSellPrice(tokenAmount);
        assertLe(payout, token.ethReserve(), "a quoted payout exceeded the entire reserve");
    }

    /// Selling more must never pay less.
    function testFuzz_GetSellPrice_IsMonotonic(uint256 seed, uint256 a, uint256 b) public {
        _buy(alice, bound(seed, 0.001 ether, 3.9 ether), 0);
        uint256 circulating = token.tokensSold();
        a = bound(a, 0, circulating);
        b = bound(b, a, circulating);

        assertGe(token.getSellPrice(b), token.getSellPrice(a), "a bigger sell paid less");
    }

    /**
     * The solvency property stated as a quote: selling the entire circulating
     * supply in one go must never be quoted above the reserve.
     *
     * This is the closed-form claim in `FolioToken`'s header — that buying back
     * every token costs exactly the real reserve — fuzzed rather than argued.
     */
    function testFuzz_GetSellPrice_WholeSupplyNeverExceedsTheReserve(uint256 ethIn) public {
        ethIn = bound(ethIn, 1, 3.9 ether);
        _buy(alice, ethIn, 0);

        uint256 gross = token.getOutstandingSellObligation();
        assertLe(gross, token.ethReserve(), "buying back everything costs more than the reserve");
        assertGe(token.reserveHealthBps(), BPS);
    }

    // =======================================================================
    // The quotes and the settlement they promise
    // =======================================================================

    /// Whatever `getBuyQuote` says, `buy` does — tokens, spend and refund.
    function testFuzz_BuyQuoteMatchesSettlement(uint256 ethIn) public {
        ethIn = bound(ethIn, 1, 1_000 ether);

        (uint256 qTokens, uint256 qSpend, uint256 qRefund) = token.getBuyQuote(ethIn);
        vm.assume(qTokens > 0);

        uint256 before = alice.balance;
        uint256 got = _buy(alice, ethIn, 0);

        assertEq(got, qTokens, "quoted tokens and settled tokens differ");
        assertEq(before - alice.balance, qSpend, "quoted spend and actual spend differ");
        assertEq(qSpend + qRefund, ethIn, "spend and refund do not add up to what was sent");
        _assertSolvent();
    }

    /// And whatever `getSellPrice` says, `sell` pays.
    function testFuzz_SellQuoteMatchesSettlement(uint256 ethIn, uint256 fraction) public {
        ethIn = bound(ethIn, 0.0001 ether, 3.9 ether);
        _buy(alice, ethIn, 0);

        uint256 held = token.balanceOf(alice);
        uint256 amount = bound(fraction, 1, held);
        uint256 quoted = token.getSellPrice(amount);
        vm.assume(quoted > 0);

        uint256 before = alice.balance;
        uint256 got = _sell(alice, amount, 0);

        assertEq(got, quoted, "quoted payout and settled payout differ");
        assertEq(alice.balance - before, quoted, "the wallet did not receive the quote");
        _assertSolvent();
    }

    // =======================================================================
    // Value extraction: can any sequence get out more than it put in?
    // =======================================================================

    /// A buy and an immediate sell always loses money. The fee is charged twice
    /// and the price impact is paid in both directions.
    function testFuzz_RoundTripNeverProfits(uint256 ethIn) public {
        ethIn = bound(ethIn, 1, 3.9 ether);

        uint256 before = alice.balance;
        uint256 tokens = _buy(alice, ethIn, 0);
        vm.assume(tokens > 0);
        if (token.getSellPrice(tokens) == 0) return; // dust, refused by the contract
        _sell(alice, tokens, 0);

        assertLe(alice.balance, before, "a round trip created ETH out of nothing");
        _assertSolvent();
    }

    /**
     * Splitting a purchase in two extracts nothing from the reserve — but it is
     * not quite a no-op, and this test pins down exactly what it does.
     *
     * The fee is `floor(ethIn * feeBps / BPS)`, taken once per call. Split a buy
     * across two calls and it floors twice, and `floor(a) + floor(b)` can be one
     * less than `floor(a + b)`. So a split buy pays the creator up to **one wei**
     * less in fees, and that wei goes into the reserve instead.
     *
     * The consequence looks alarming in token terms and is not: early on this
     * curve a single wei buys around 5e5 units, so the splitter can come away
     * with a visibly larger token balance. Those tokens are fully backed — the
     * wei backing them is sitting in the reserve — so solvency is untouched. The
     * cost falls on the creator's fee income, it is capped at one wei per extra
     * transaction, and it costs tens of thousands of gas to collect. It is a
     * rounding artifact, not an exploit.
     *
     * What the assertions below establish is that this is the *whole* story:
     * the ETH accounting is exact, the drift is bounded at one wei, and the
     * reserve is the only thing that gains.
     */
    function testFuzz_SplittingABuyOnlyEverRoundsTheFeeDown(uint256 ethIn, uint256 splitBps)
        public
    {
        ethIn = bound(ethIn, 0.001 ether, 3 ether);
        splitBps = bound(splitBps, 1, BPS - 1);
        uint256 firstHalf = (ethIn * splitBps) / BPS;
        uint256 secondHalf = ethIn - firstHalf;
        vm.assume(firstHalf > 0 && secondHalf > 0);

        // One shot, on a fresh launch.
        FolioToken whole = _create(SUPPLY);
        uint256 inOneGo = _buyOn(whole, alice, ethIn, 0);

        // Two shots, on an identical fresh launch.
        FolioToken split = _create(SUPPLY);
        uint256 inTwo = _buyOn(split, bob, firstHalf, 0) + _buyOn(split, bob, secondHalf, 0);

        // Neither launch created or destroyed a wei: what was sent is split
        // between reserve and fees, exactly, in both cases.
        assertEq(whole.ethReserve() + whole.feesAccrued(), ethIn, "one-go accounting is not exact");
        assertEq(split.ethReserve() + split.feesAccrued(), ethIn, "split accounting is not exact");

        // The drift is entirely in the fee, it can only go one way, and it is
        // capped at one wei for one extra call.
        assertLe(split.feesAccrued(), whole.feesAccrued(), "splitting somehow paid more fees");
        assertLe(whole.feesAccrued() - split.feesAccrued(), 1, "fee drift exceeded a single wei");

        // Whatever the fee lost, the reserve gained — nobody else is out of pocket.
        assertGe(split.ethReserve(), whole.ethReserve(), "splitting took ETH out of the reserve");
        uint256 reserveSurplus = split.ethReserve() - whole.ethReserve();
        assertEq(reserveSurplus, whole.feesAccrued() - split.feesAccrued(), "the wei went missing");
        assertLe(reserveSurplus, 1);

        // Any extra tokens the splitter holds are backed by that surplus wei.
        if (inTwo > inOneGo) {
            assertEq(reserveSurplus, 1, "extra tokens appeared without extra ETH backing them");
        }

        _assertSolventOn(whole);
        _assertSolventOn(split);
    }

    /// And unwinding the split position does not turn that wei into a profit:
    /// both strategies end the round trip out of pocket.
    function testFuzz_SplittingABuyStillLosesOnTheRoundTrip(uint256 ethIn, uint256 splitBps)
        public
    {
        ethIn = bound(ethIn, 0.001 ether, 3 ether);
        splitBps = bound(splitBps, 1, BPS - 1);
        uint256 firstHalf = (ethIn * splitBps) / BPS;
        uint256 secondHalf = ethIn - firstHalf;
        vm.assume(firstHalf > 0 && secondHalf > 0);

        uint256 startB = bob.balance;
        FolioToken split = _create(SUPPLY);
        _buyOn(split, bob, firstHalf, 0);
        _buyOn(split, bob, secondHalf, 0);

        uint256 held = split.balanceOf(bob);
        vm.assume(held > 0 && split.getSellPrice(held) > 0);
        _sellOn(split, bob, held, 0);

        assertLt(bob.balance, startB, "a split buy unwound for a profit");
        _assertSolventOn(split);
    }

    /**
     * Selling in slices does not beat selling in one go either.
     *
     * The same wei-level fee rounding applies on this leg, so the comparison is
     * made against a small absolute tolerance rather than an exact equality. The
     * tolerance is a flat handful of wei on purpose: a leak that scaled with
     * trade size would blow through it at the top of the fuzz range, which is
     * what makes the loose-looking bound a real check.
     */
    function testFuzz_SplittingASellExtractsNothing(uint256 ethIn, uint256 splitBps) public {
        ethIn = bound(ethIn, 0.01 ether, 3 ether);
        splitBps = bound(splitBps, 1, BPS - 1);

        FolioToken whole = _create(SUPPLY);
        uint256 heldWhole = _buyOn(whole, alice, ethIn, 0);
        vm.assume(heldWhole > 1);
        uint256 inOneGo = _sellOn(whole, alice, heldWhole, 0);

        FolioToken split = _create(SUPPLY);
        uint256 heldSplit = _buyOn(split, bob, ethIn, 0);
        uint256 firstSlice = (heldSplit * splitBps) / BPS;
        vm.assume(firstSlice > 0 && firstSlice < heldSplit);
        vm.assume(split.getSellPrice(firstSlice) > 0);
        uint256 inTwo = _sellOn(split, bob, firstSlice, 0);
        uint256 rest = split.balanceOf(bob);
        if (split.getSellPrice(rest) > 0) inTwo += _sellOn(split, bob, rest, 0);

        assertLe(inTwo, inOneGo + 2, "slicing a sell paid out more than selling at once");
        _assertSolventOn(whole);
        _assertSolventOn(split);
    }

    /**
     * The general shape of the extraction question: run a random ladder of buys
     * and then unwind the whole position, and check that what comes back is
     * never more than what went in.
     *
     * A curve that could be beaten this way is the one bug in this contract
     * whose blast radius is the whole reserve, so it is worth stating on its own
     * rather than leaving to the invariant run.
     */
    function testFuzz_LadderedBuysThenFullExitNeverProfits(uint256 seed, uint8 steps) public {
        uint256 count = bound(steps, 1, 12);
        uint256 spent;
        uint256 before = alice.balance;

        for (uint256 i = 0; i < count; i++) {
            uint256 size = bound(uint256(keccak256(abi.encode(seed, i))), 1e9, 0.3 ether);
            if (token.ethHeadroom() == 0 || token.graduated()) break;
            _buy(alice, size, 0);
            spent += size;
            _assertSolvent();
        }

        uint256 held = token.balanceOf(alice);
        vm.assume(held > 0);
        if (token.getSellPrice(held) > 0) _sell(alice, held, 0);

        assertLe(alice.balance, before, "a ladder of buys unwound for a profit");
        assertLe(alice.balance + spent - before, spent, "more came back than went in");
        _assertSolvent();
    }

    /**
     * Two traders, random sizes, interleaved. Whatever the order, the pair
     * cannot together take out more ETH than they together put in.
     */
    function testFuzz_TwoTradersCannotJointlyExtractValue(
        uint256 aliceIn,
        uint256 bobIn,
        bool aliceFirst
    ) public {
        aliceIn = bound(aliceIn, 1e12, 1.5 ether);
        bobIn = bound(bobIn, 1e12, 1.5 ether);

        uint256 startA = alice.balance;
        uint256 startB = bob.balance;

        if (aliceFirst) {
            _buy(alice, aliceIn, 0);
            _buy(bob, bobIn, 0);
        } else {
            _buy(bob, bobIn, 0);
            _buy(alice, aliceIn, 0);
        }
        _assertSolvent();

        // Unwind in the opposite order to the one they bought in — the case
        // where an ordering advantage would show up if there were one.
        uint256 aliceHeld = token.balanceOf(alice);
        uint256 bobHeld = token.balanceOf(bob);
        if (aliceFirst) {
            if (bobHeld > 0 && token.getSellPrice(bobHeld) > 0) _sell(bob, bobHeld, 0);
            if (aliceHeld > 0 && token.getSellPrice(aliceHeld) > 0) _sell(alice, aliceHeld, 0);
        } else {
            if (aliceHeld > 0 && token.getSellPrice(aliceHeld) > 0) _sell(alice, aliceHeld, 0);
            if (bobHeld > 0 && token.getSellPrice(bobHeld) > 0) _sell(bob, bobHeld, 0);
        }

        uint256 endA = alice.balance;
        uint256 endB = bob.balance;
        assertLe(endA + endB, startA + startB, "two traders jointly extracted ETH from the curve");
        _assertSolvent();
    }

    // =======================================================================
    // The curve product, under random pressure
    // =======================================================================

    /// `k` only ever grows: every rounding decision in the contract is resolved
    /// in the reserve's favour, so numerical dust accumulates as surplus.
    function testFuzz_CurveProductNeverShrinks(uint256 ethIn, uint256 sellBps) public {
        ethIn = bound(ethIn, 1e9, 3.9 ether);
        sellBps = bound(sellBps, 1, BPS);

        uint256 k0 = _k(token);
        uint256 tokens = _buy(alice, ethIn, 0);
        uint256 k1 = _k(token);
        assertGe(k1, k0, "a buy shrank the curve product");

        uint256 amount = (tokens * sellBps) / BPS;
        vm.assume(amount > 0);
        vm.assume(token.getSellPrice(amount) > 0);
        _sell(alice, amount, 0);

        assertGe(_k(token), k1, "a sell shrank the curve product");
        _assertSolvent();
    }

    // =======================================================================
    // Fuzzing the configuration itself
    // =======================================================================

    /**
     * A launch on *any* admissible configuration still holds every property this
     * suite cares about. The bounds below are the factory's own, so this fuzzes
     * the whole space of launches the platform can actually produce rather than
     * only the one the other tests use.
     */
    function testFuzz_AnyAdmissibleLaunchStaysSolvent(
        uint256 virtualEth,
        uint256 cap,
        uint256 gradPct,
        uint16 fee,
        uint256 wholeSupply,
        uint256 ethIn
    ) public {
        virtualEth = bound(
            virtualEth, factory.MIN_VIRTUAL_ETH_RESERVE(), factory.MAX_VIRTUAL_ETH_RESERVE()
        );
        cap = bound(cap, factory.MIN_RESERVE_CAP(), factory.MAX_RESERVE_CAP());
        fee = uint16(bound(fee, 0, factory.MAX_FEE_BPS()));
        // The factory refuses a supply the virtual reserve cannot price.
        wholeSupply = bound(wholeSupply, 1, _min(virtualEth, factory.MAX_WHOLE_SUPPLY()));

        CurveConfig memory cfg = CurveConfig({
            virtualEthReserve: virtualEth,
            maxReserveCap: cap,
            graduationThreshold: (cap * bound(gradPct, 0, 100)) / 100,
            feeBps: fee,
            priceMoveAlertBps: 10_000,
            sniperWindowSeconds: 0,
            sniperMaxEthPerWallet: 0
        });

        vm.prank(owner);
        factory.setDefaultConfig(cfg);
        FolioToken t = _create(wholeSupply);

        assertEq(t.feeBps(), fee);
        assertEq(t.maxReserveCap(), cap);
        assertGe(t.currentPrice(), 1, "an admissible launch opened at a price of zero");

        ethIn = bound(ethIn, 1, 100_000 ether);
        vm.deal(alice, ethIn + 1 ether);
        (uint256 quoted,,) = t.getBuyQuote(ethIn);
        vm.assume(quoted > 0);

        _buyOn(t, alice, ethIn, 0);
        _assertSolventOn(t);

        uint256 held = t.balanceOf(alice);
        if (t.getSellPrice(held) > 0) _sellOn(t, alice, held, 0);
        _assertSolventOn(t);
    }

    /// The reserve cap holds against any purchase on any admissible cap.
    function testFuzz_ReserveNeverBreaksItsCap(uint256 capChoice, uint256 ethIn, uint8 buys)
        public
    {
        uint256 cap = bound(capChoice, factory.MIN_RESERVE_CAP(), 5 ether);
        FolioToken t = _createWithoutGraduation(cap);
        uint256 rounds = bound(buys, 1, 8);

        for (uint256 i = 0; i < rounds; i++) {
            uint256 size = bound(uint256(keccak256(abi.encode(ethIn, i))), 1, 20 ether);
            if (t.ethHeadroom() == 0) {
                vm.prank(alice);
                vm.expectRevert(FolioToken.CurveClosed.selector);
                t.buy{value: size}(0);
                break;
            }
            (uint256 quoted,,) = t.getBuyQuote(size);
            if (quoted == 0) continue;
            _buyOn(t, alice, size, 0);
            assertLe(t.ethReserve(), cap, "the reserve broke through its cap");
            _assertSolventOn(t);
        }
    }

    /// Whatever the fee, it is charged on the buy leg and never taken out of the
    /// reserve — the property that keeps the sell-back guarantee exact.
    function testFuzz_FeesNeverTouchTheReserve(uint16 fee, uint256 ethIn, uint256 sellBps) public {
        fee = uint16(bound(fee, 0, factory.MAX_FEE_BPS()));
        CurveConfig memory cfg = _config();
        cfg.feeBps = fee;
        vm.prank(owner);
        factory.setDefaultConfig(cfg);
        FolioToken t = _create(SUPPLY);

        ethIn = bound(ethIn, 1e12, 3.9 ether);
        uint256 tokens = _buyOn(t, alice, ethIn, 0);

        assertEq(t.feesAccrued(), (ethIn * fee) / BPS, "the buy fee is not what the rate says");
        assertEq(t.ethReserve(), ethIn - t.feesAccrued(), "the rest did not reach the reserve");

        uint256 amount = (tokens * bound(sellBps, 1, BPS)) / BPS;
        vm.assume(amount > 0 && t.getSellPrice(amount) > 0);

        uint256 feesBefore = t.feesAccrued();
        uint256 reserveBefore = t.ethReserve();
        uint256 paid = _sellOn(t, alice, amount, 0);
        uint256 grossPaid = reserveBefore - t.ethReserve();

        assertEq(t.feesAccrued() - feesBefore, (grossPaid * fee) / BPS, "the sell fee is wrong");
        assertEq(paid, grossPaid - (grossPaid * fee) / BPS, "the seller was paid the wrong net");

        // The creator claiming does not reduce anyone's ability to sell.
        uint256 obligationBefore = t.getOutstandingSellObligation();
        if (t.feesAccrued() > 0) {
            vm.prank(creator);
            t.claimFees();
        }
        assertEq(t.getOutstandingSellObligation(), obligationBefore, "a claim moved the curve");
        _assertSolventOn(t);
    }

    // =======================================================================
    // Slippage protection
    // =======================================================================

    /// A floor set at the quote always holds when nothing intervenes, and always
    /// bites when something does.
    function testFuzz_SlippageFloorIsExact(uint256 ethIn) public {
        ethIn = bound(ethIn, 1e12, 1 ether);
        (uint256 quoted,,) = token.getBuyQuote(ethIn);
        vm.assume(quoted > 0);

        // Nothing in between: the exact quote is accepted as the floor.
        uint256 got = _buy(alice, ethIn, quoted);
        assertEq(got, quoted);

        // One unit above what the curve can now deliver is refused.
        (uint256 next,,) = token.getBuyQuote(ethIn);
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(FolioToken.SlippageExceeded.selector, next, next + 1)
        );
        token.buy{value: ethIn}(next + 1);
        _assertSolvent();
    }

    /// The same on the sell leg.
    function testFuzz_SellSlippageFloorIsExact(uint256 ethIn) public {
        ethIn = bound(ethIn, 1e14, 3 ether);
        uint256 tokens = _buy(alice, ethIn, 0);
        uint256 quoted = token.getSellPrice(tokens);
        vm.assume(quoted > 0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(FolioToken.SlippageExceeded.selector, quoted, quoted + 1)
        );
        token.sell(tokens, quoted + 1);

        uint256 got = _sell(alice, tokens, quoted);
        assertEq(got, quoted);
        _assertSolvent();
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
