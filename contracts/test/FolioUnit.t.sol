// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";
import {FolioTestBase} from "./helpers/FolioTestBase.sol";

/**
 * Stage 4, part one: the happy path, checked against the curve rather than
 * against the contract's own quotes.
 *
 * Stage 2 already establishes that `getBuyQuote` and `buy` agree. What it cannot
 * establish is that either of them is *right*, because both run the same
 * function. Every settlement below is compared against {_predictBuy} /
 * {_predictSell}, which are written out from `x * y = k` in the base contract
 * using plain arithmetic. When those agree with the contract, the curve is
 * implemented correctly; when stage 2's tests agree with the contract, the
 * contract is merely self-consistent.
 */
contract FolioUnitTest is FolioTestBase {
    // =======================================================================
    // Creating a launch
    // =======================================================================

    /// Every field `initialize` is given, read back off the deployed clone.
    function test_Create_StoresEveryParameter() public {
        CurveConfig memory cfg = _config();

        vm.prank(creator);
        FolioToken t = FolioToken(factory.createToken("Midnight Kettle", "KETL", 250_000));

        // Identity and metadata.
        assertEq(t.name(), "Midnight Kettle");
        assertEq(t.symbol(), "KETL");
        assertEq(t.decimals(), 18);
        assertEq(t.factory(), address(factory), "factory is the emergency-stop source");
        assertEq(t.creator(), creator, "creator is the fee recipient");

        // Curve terms, copied from the platform default.
        assertEq(t.virtualEthReserve(), cfg.virtualEthReserve);
        assertEq(t.maxReserveCap(), cfg.maxReserveCap);
        assertEq(t.graduationThreshold(), cfg.graduationThreshold);
        assertEq(t.feeBps(), cfg.feeBps);
        assertEq(t.priceMoveAlertBps(), cfg.priceMoveAlertBps);

        // Opening curve state: the whole supply is inventory, none of it minted.
        assertEq(t.curveSupply(), 250_000 * UNIT, "18 decimals are added by the token");
        assertEq(t.curveTokenReserve(), 250_000 * UNIT);
        assertEq(t.totalSupply(), 0, "nothing is pre-minted");
        assertEq(t.balanceOf(creator), 0, "the creator gets no allocation");
        assertEq(t.tokensSold(), 0);
        assertEq(t.ethReserve(), 0);
        assertEq(t.feesAccrued(), 0);
        assertFalse(t.graduated());

        // And the derived views agree with all of it.
        assertEq(t.currentPrice(), cfg.virtualEthReserve / 250_000, "opening price is V / supply");
        assertEq(t.marketCap(), cfg.virtualEthReserve, "opening market cap is exactly V");
        assertEq(t.circulatingMarketCap(), 0);
        assertEq(t.ethHeadroom(), cfg.graduationThreshold, "graduation binds before the cap");
        assertEq(t.reserveHealthBps(), BPS);
        assertTrue(factory.isFolioToken(address(t)));
    }

    // =======================================================================
    // Buying
    // =======================================================================

    /// A normal buy, priced against the curve written out independently.
    function test_Buy_DeliversExactlyWhatTheCurveSays() public {
        uint256 ethIn = 1 ether;
        (uint256 wantTokens, uint256 wantNet, uint256 wantFee) = _predictBuy(token, ethIn);

        uint256 got = _buy(alice, ethIn, 0);

        assertEq(got, wantTokens, "tokens out disagree with the curve");
        assertEq(token.balanceOf(alice), wantTokens, "buyer was not credited");
        assertEq(token.totalSupply(), wantTokens, "a buy mints exactly what it hands out");
        assertEq(token.tokensSold(), wantTokens);
        assertEq(token.ethReserve(), wantNet, "only the post-fee ETH reaches the reserve");
        assertEq(token.feesAccrued(), wantFee, "the fee is skimmed before the curve");
        assertEq(wantFee, ethIn / 100, "1% at the factory default");
        assertEq(address(token).balance, ethIn, "every wei sent is still here");
        _assertSolvent();
    }

    /// The same check across a spread of sizes, each on a curve the previous
    /// buys have already moved.
    function test_Buy_TracksTheCurveAcrossASequence() public {
        uint256[5] memory sizes = [uint256(0.001 ether), 0.05 ether, 0.4 ether, 1 ether, 1.5 ether];
        address[5] memory buyers = [alice, bob, carol, dave, eve];

        for (uint256 i = 0; i < sizes.length; i++) {
            (uint256 wantTokens, uint256 wantNet,) = _predictBuy(token, sizes[i]);
            uint256 reserveBefore = token.ethReserve();

            uint256 got = _buy(buyers[i], sizes[i], 0);

            assertEq(got, wantTokens, "settlement drifted from the curve mid-sequence");
            assertEq(token.ethReserve(), reserveBefore + wantNet);
            _assertSolvent();
        }
    }

    /// Buying twice gives the second buyer less per wei than the first, which is
    /// the entire point of a bonding curve.
    function test_Buy_LaterBuyersPayMore() public {
        uint256 first = _buy(alice, 1 ether, 0);
        uint256 second = _buy(bob, 1 ether, 0);

        assertLt(second, first, "the price did not rise between identical buys");
        assertGt(token.currentPrice(), 0);
    }

    // =======================================================================
    // Selling
    // =======================================================================

    /// A normal sell, priced against the independently written curve, with the
    /// spread checked as a number rather than asserted as a direction.
    function test_Sell_PaysExactlyWhatTheCurveSaysLessTheSpread() public {
        _buy(alice, 2 ether, 0);
        uint256 held = token.balanceOf(alice);
        uint256 amount = held / 3;

        (uint256 wantOut, uint256 wantGross, uint256 wantFee) = _predictSell(token, amount);
        uint256 reserveBefore = token.ethReserve();
        uint256 feesBefore = token.feesAccrued();
        uint256 walletBefore = alice.balance;

        uint256 got = _sell(alice, amount, 0);

        assertEq(got, wantOut, "payout disagrees with the curve");
        assertEq(alice.balance, walletBefore + wantOut, "the seller was not paid");
        assertEq(token.balanceOf(alice), held - amount, "tokens were not burned");
        assertEq(token.totalSupply(), held - amount);
        assertEq(token.tokensSold(), held - amount);
        assertEq(token.ethReserve(), reserveBefore - wantGross, "the reserve gave up the gross");
        assertEq(token.feesAccrued(), feesBefore + wantFee, "the fee came off the payout");
        assertEq(wantFee, wantGross / 100, "1% at the factory default");
        _assertSolvent();
    }

    /// The round trip costs the two fees plus the trade's own price impact, and
    /// the seller is never handed more than they paid.
    function test_Sell_RoundTripCostsTheSpreadAndNothingIsCreated() public {
        uint256 ethIn = 1 ether;
        uint256 before = alice.balance;

        uint256 tokens = _buy(alice, ethIn, 0);
        uint256 back = _sell(alice, tokens, 0);
        uint256 cost = ethIn - back;

        assertLt(back, ethIn, "a round trip returned at least what it cost");
        assertEq(alice.balance, before - ethIn + back);
        assertEq(token.balanceOf(alice), 0);

        // Conservation, stated exactly: every wei that did not come back is
        // either an accrued fee or rounding dust left in the reserve. Nothing
        // else can absorb it, which is the whole claim.
        assertEq(
            cost,
            token.feesAccrued() + token.ethReserve(),
            "the round trip lost ETH to something other than fees and dust"
        );

        // The two fees compound rather than add: the sell leg is charged on the
        // 99% that reached the reserve, so a 1%/1% schedule costs 1.99%, not 2%.
        uint256 twoFees = ethIn * 199 / BPS;
        assertGe(cost, twoFees - 2, "the round trip cost less than the fee schedule implies");
        assertLe(cost, ethIn * 2 / 100, "the round trip cost more than two full fees");
    }

    /// Selling everything back empties the curve to where it started, minus the
    /// fees that were never part of the reserve.
    function test_Sell_FullExitReturnsTheCurveToItsOpeningState() public {
        uint256 openingPrice = token.currentPrice();

        uint256 a = _buy(alice, 1 ether, 0);
        uint256 b = _buy(bob, 2 ether, 0);
        _sell(alice, a, 0);
        _sell(bob, b, 0);

        assertEq(token.totalSupply(), 0, "every token was burned");
        assertEq(token.tokensSold(), 0);
        assertEq(token.curveTokenReserve(), SUPPLY * UNIT, "inventory is whole again");
        assertLe(token.ethReserve(), 2, "the reserve is empty but for rounding dust");
        assertGe(token.currentPrice(), openingPrice, "rounding must favour the curve");
        assertEq(
            address(token).balance,
            token.ethReserve() + token.feesAccrued(),
            "what is left is dust plus unclaimed fees, and nothing else"
        );
        _assertSolvent();
    }

    // =======================================================================
    // Several launches at once
    // =======================================================================

    /**
     * Three launches from three creators, traded against each other in an
     * interleaved order. Clones share one implementation, so this is the test
     * that would catch a variable that had accidentally been left on the
     * implementation's storage instead of the proxy's.
     */
    function test_MultipleLaunches_DoNotShareState() public {
        address c1 = makeAddr("c1");
        address c2 = makeAddr("c2");
        address c3 = makeAddr("c3");

        FolioToken t1 = _createAs(c1, "One", "ONE", 100_000);
        FolioToken t2 = _createAs(c2, "Two", "TWO", 500_000);
        FolioToken t3 = _createAs(c3, "Three", "THR", 1_000_000);

        assertTrue(address(t1) != address(t2) && address(t2) != address(t3));

        // Interleaved so no launch sees a clean run of its own.
        _buyOn(t1, alice, 1 ether, 0);
        _buyOn(t2, bob, 0.5 ether, 0);
        _buyOn(t1, bob, 0.25 ether, 0);
        _buyOn(t3, carol, 2 ether, 0);
        _buyOn(t2, alice, 1 ether, 0);
        uint256 paidOutByT1 = _sellOn(t1, alice, t1.balanceOf(alice) / 2, 0);
        _buyOn(t3, alice, 0.1 ether, 0);

        // Each launch kept its own identity.
        assertEq(t1.creator(), c1);
        assertEq(t2.creator(), c2);
        assertEq(t3.creator(), c3);
        assertEq(t1.curveSupply(), 100_000 * UNIT);
        assertEq(t2.curveSupply(), 500_000 * UNIT);
        assertEq(t3.curveSupply(), 1_000_000 * UNIT);

        // Each kept its own ETH, and none of it moved between launches.
        assertEq(
            address(t1).balance,
            1.25 ether - paidOutByT1,
            "t1 holds what it took in, less its payout"
        );
        assertEq(address(t2).balance, 1.5 ether, "t2 has had no sells and holds every wei");
        assertEq(address(t3).balance, 2.1 ether, "t3 has had no sells and holds every wei");

        // And balances did not leak across launches.
        assertEq(t1.balanceOf(carol), 0);
        assertEq(t3.balanceOf(bob), 0);
        assertGt(t2.balanceOf(alice), 0);

        _assertSolventOn(t1);
        _assertSolventOn(t2);
        _assertSolventOn(t3);

        // Fees are per launch and per creator.
        vm.prank(c1);
        t1.claimFees();
        assertGt(t2.feesAccrued(), 0, "claiming on one launch drained another");
    }

    /// A creator has no authority over a launch that is not theirs.
    function test_MultipleLaunches_CreatorsCannotReachEachOther() public {
        FolioToken mine = _createAs(alice, "Mine", "MINE", 100_000);
        FolioToken yours = _createAs(bob, "Yours", "YRS", 100_000);

        _buyOn(mine, carol, 1 ether, 0);
        _buyOn(yours, carol, 1 ether, 0);

        vm.prank(alice);
        vm.expectRevert(FolioToken.NotCreator.selector);
        yours.claimFees();

        vm.prank(bob);
        vm.expectRevert(FolioToken.NotCreator.selector);
        mine.claimFees();
    }

    // =======================================================================
    // Edge cases: the zero and the too-small
    // =======================================================================

    function test_Edge_BuyWithZeroValue() public {
        vm.prank(alice);
        vm.expectRevert(FolioToken.ZeroEthIn.selector);
        token.buy{value: 0}(0);
    }

    /// Zero is rejected on a curve that is already trading, not just an empty
    /// one — the guard is unconditional.
    function test_Edge_BuyWithZeroValueAfterTradingHasStarted() public {
        _buy(alice, 1 ether, 0);
        vm.prank(bob);
        vm.expectRevert(FolioToken.ZeroEthIn.selector);
        token.buy{value: 0}(0);
    }

    function test_Edge_SellZeroTokens() public {
        _buy(alice, 1 ether, 0);
        vm.prank(alice);
        vm.expectRevert(FolioToken.ZeroTokenAmount.selector);
        token.sell(0, 0);
    }

    /// Zero is refused before the balance check, so it reverts the same way for
    /// somebody holding nothing.
    function test_Edge_SellZeroTokensHoldingNothing() public {
        vm.prank(bob);
        vm.expectRevert(FolioToken.ZeroTokenAmount.selector);
        token.sell(0, 0);
    }

    /// Selling more than you hold, while staying inside the circulating supply,
    /// is the ERC20 balance check that catches it.
    function test_Edge_SellMoreThanHeld() public {
        _buy(alice, 1 ether, 0);
        _buy(bob, 1 ether, 0);
        uint256 held = token.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, held, held + 1
            )
        );
        token.sell(held + 1, 0);

        // Nothing moved.
        assertEq(token.balanceOf(alice), held);
        _assertSolvent();
    }

    /// Selling past the circulating supply is caught earlier, by the curve's own
    /// guard, before the ERC20 ever sees it.
    function test_Edge_SellMoreThanExists() public {
        _buy(alice, 1 ether, 0);
        // Read before arming the expectation: `vm.expectRevert` applies to the
        // very next call, and an argument that is itself a call would consume it.
        uint256 oneTooMany = token.tokensSold() + 1;

        vm.prank(alice);
        vm.expectRevert(FolioToken.ExceedsCirculating.selector);
        token.sell(oneTooMany, 0);
    }

    /// Someone holding nothing at all cannot sell one unit.
    function test_Edge_SellAsANonHolder() public {
        _buy(alice, 1 ether, 0);
        vm.prank(eve);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, eve, 0, 1e18)
        );
        token.sell(1e18, 0);
    }

    // =======================================================================
    // Edge cases: rounding at one wei and one unit
    // =======================================================================

    /**
     * One wei is a real trade on this launch, and it must not create value.
     *
     * At the opening price a wei buys about 500k units of a 1e24-unit supply, so
     * it is not rejected — but it must move `k` up rather than down, and selling
     * the result back must return strictly less than the wei it cost.
     */
    function test_Edge_BuyOneWei() public {
        uint256 kBefore = _k(token);
        (uint256 predicted,,) = _predictBuy(token, 1);

        uint256 got = _buy(alice, 1, 0);

        assertEq(got, predicted, "one wei did not price off the curve");
        assertGt(got, 0, "one wei bought nothing at the opening price");
        assertEq(token.ethReserve(), 1, "the whole wei is reserve: the 1% fee floors to zero");
        assertEq(token.feesAccrued(), 0);
        assertGe(_k(token), kBefore, "one wei shrank the curve product");
        _assertSolvent();
    }

    /// And it cannot be turned back into a wei, let alone more than one.
    function test_Edge_OneWeiRoundTripReturnsNothing() public {
        uint256 got = _buy(alice, 1, 0);

        vm.prank(alice);
        vm.expectRevert(FolioToken.PayoutTooSmall.selector);
        token.sell(got, 0);

        assertEq(token.ethReserve(), 1, "the wei stayed in the reserve");
        _assertSolvent();
    }

    /**
     * One token unit — 1e-18 of a token — prices to nothing on this curve, and
     * the contract refuses the trade rather than burning it for zero ETH.
     *
     * This is the rounding case that matters: the alternative implementation,
     * where the burn happens and the payout floors to zero, is a real way to
     * lose tokens for free.
     */
    function test_Edge_SellOneUnitIsRefusedRatherThanBurnedForFree() public {
        _buy(alice, 1 ether, 0);
        uint256 held = token.balanceOf(alice);

        (uint256 predicted,,) = _predictSell(token, 1);
        assertEq(predicted, 0, "the curve does price one unit at zero here");

        vm.prank(alice);
        vm.expectRevert(FolioToken.PayoutTooSmall.selector);
        token.sell(1, 0);

        assertEq(token.balanceOf(alice), held, "the unit was not burned");
        _assertSolvent();
    }

    /// The smallest sell that does pay out, found by walking up from one unit.
    /// Below the boundary it reverts, at it the payout is a wei, and the reserve
    /// stays covered on either side.
    function test_Edge_SmallestSellThatPaysOut() public {
        _buy(alice, 1 ether, 0);

        // `gross = x * amt / (y + amt)` reaches one wei exactly when
        // `amt * (x - 1) >= y`, so the smallest paying sell is `ceil(y / (x-1))`.
        // Derived rather than guessed, so the assertions below hold for any state
        // this test is run from rather than for one lucky remainder.
        uint256 x = token.virtualEthReserve() + token.ethReserve();
        uint256 y = token.curveTokenReserve();
        uint256 boundary = (y + (x - 1) - 1) / (x - 1);
        assertGt(boundary, 1, "the boundary must leave a non-zero amount below it");

        (uint256 justUnder,,) = _predictSell(token, boundary - 1);
        (uint256 atBoundary, uint256 gross,) = _predictSell(token, boundary);

        assertEq(justUnder, 0, "the unit below the boundary should price to zero");
        assertGe(gross, 1, "the boundary should produce at least a wei gross");

        vm.prank(alice);
        vm.expectRevert(FolioToken.PayoutTooSmall.selector);
        token.sell(boundary - 1, 0);

        // At the boundary the gross is a wei; the 1% fee floors to zero, so the
        // seller takes the whole wei.
        assertEq(atBoundary, gross, "a sub-100-wei fee must floor to zero");
        uint256 paid = _sell(alice, boundary, 0);
        assertEq(paid, atBoundary);
        _assertSolvent();
    }

    /// Buying a single wei repeatedly must not let dust accumulate into value.
    function test_Edge_ManyOneWeiBuysNeverOutrunTheirCost() public {
        uint256 spent;
        for (uint256 i = 0; i < 50; i++) {
            _buy(alice, 1, 0);
            spent += 1;
        }

        uint256 held = token.balanceOf(alice);
        (uint256 wouldGet,,) = _predictSell(token, held);

        assertLe(wouldGet, spent, "fifty wei in came back as more than fifty wei of value");
        assertEq(token.ethReserve(), spent, "every wei landed in the reserve");
        _assertSolvent();
    }

    // =======================================================================
    // Edge cases: the very large
    // =======================================================================

    /// A buy far past the ceiling fills the reserve to exactly the threshold and
    /// hands back the rest, rather than reverting.
    function test_Edge_BuyVastlyExceedingTheCeiling() public {
        vm.deal(alice, 10_000 ether);
        uint256 before = alice.balance;

        (uint256 quotedTokens, uint256 quotedSpend, uint256 quotedRefund) =
            token.getBuyQuote(5_000 ether);
        uint256 got = _buy(alice, 5_000 ether, 0);

        assertEq(got, quotedTokens, "the quote did not match settlement at the ceiling");
        assertEq(token.ethReserve(), 4 ether, "the reserve landed exactly on the threshold");
        assertTrue(token.graduated(), "reaching the threshold closes the curve");
        assertEq(before - alice.balance, quotedSpend, "the buyer paid more than the quote said");
        assertGt(quotedRefund, 4_900 ether, "almost all of it should have come back");
        assertEq(token.ethHeadroom(), 0);
        _assertSolvent();
    }

    /// The same with a `msg.value` at the edge of what an account could hold.
    function test_Edge_BuyWithAnAbsurdlyLargeValue() public {
        uint256 absurd = 1_000_000_000 ether;
        vm.deal(alice, absurd);

        uint256 got = _buy(alice, absurd, 0);

        assertGt(got, 0);
        assertEq(token.ethReserve(), 4 ether, "the ceiling held against a billion ether");
        // The reserve fills to exactly 4 ETH; the fee on top is the gross that
        // nets to it, i.e. `4 / 0.99 - 4`, which is `4 / 99`.
        uint256 fillPlusFee = 4 ether + uint256(4 ether) / 99 + 1;
        assertLe(address(token).balance, fillPlusFee, "the contract kept more than the fill + fee");
        assertGe(alice.balance, absurd - 5 ether, "the rest was refunded");
        _assertSolvent();
    }

    /// A buy at the cap when graduation is switched off — the other ceiling.
    function test_Edge_BuyVastlyExceedingTheHardCap() public {
        token = _createWithoutGraduation(1 ether);
        vm.deal(alice, 10_000 ether);

        _buy(alice, 5_000 ether, 0);

        assertEq(token.ethReserve(), 1 ether, "the reserve landed exactly on the cap");
        assertFalse(token.graduated(), "the cap is not graduation");
        assertEq(token.ethHeadroom(), 0);

        // Buying again is refused outright: there is no headroom left to fill.
        vm.prank(bob);
        vm.expectRevert(FolioToken.CurveClosed.selector);
        token.buy{value: 1 ether}(0);
        _assertSolvent();
    }

    /// Quoting a purchase of the curve's entire remaining inventory has no
    /// answer — the last token sits at a vertical asymptote.
    function test_Edge_BuyPriceForTheWholeInventoryHasNoAnswer() public {
        uint256 inventory = token.curveTokenReserve();

        vm.expectRevert(FolioToken.ExceedsCurveInventory.selector);
        token.getBuyPrice(inventory);

        vm.expectRevert(FolioToken.ExceedsCurveInventory.selector);
        token.getBuyPrice(type(uint256).max);

        // One unit below it is priced, and the number is enormous.
        uint256 cost = token.getBuyPrice(inventory - 1);
        assertGt(cost, 1e30, "the asymptote should be astronomically expensive");
    }

    /// No amount of ETH can buy the whole supply: the curve is asymptotic, so
    /// the ceiling binds long before the inventory does.
    function test_Edge_TheCurveNeverSellsOut() public {
        vm.deal(alice, 1_000_000 ether);
        _buy(alice, 1_000_000 ether, 0);

        assertLt(token.tokensSold(), token.curveSupply(), "the curve issued its entire supply");
        assertGt(token.curveTokenReserve(), 0, "inventory hit zero, which the curve forbids");
        _assertSolvent();
    }

    // =======================================================================
    // Edge cases: extreme creation parameters
    // =======================================================================

    function test_Edge_CreateWithZeroSupply() public {
        vm.prank(creator);
        vm.expectRevert(FolioFactory.InvalidSupply.selector);
        factory.createToken("Zero", "ZRO", 0);
    }

    function test_Edge_CreateWithMaxUintSupply() public {
        vm.prank(creator);
        vm.expectRevert(FolioFactory.InvalidSupply.selector);
        factory.createToken("Max", "MAX", type(uint256).max);
    }

    /// One over the platform ceiling, which is the boundary that actually gets
    /// tested by a mistake rather than by an attack.
    function test_Edge_CreateOneOverTheSupplyCeiling() public {
        uint256 oneTooMany = factory.MAX_WHOLE_SUPPLY() + 1;

        vm.prank(creator);
        vm.expectRevert(FolioFactory.InvalidSupply.selector);
        factory.createToken("Over", "OVR", oneTooMany);
    }

    /// Exactly at the ceiling is allowed, and the resulting launch trades.
    function test_Edge_CreateAtTheSupplyCeiling() public {
        uint256 max = factory.MAX_WHOLE_SUPPLY();
        vm.prank(creator);
        FolioToken t = FolioToken(factory.createToken("Max", "MAX", max));

        assertEq(t.curveSupply(), max * UNIT);
        assertGe(t.currentPrice(), 1, "the opening price must not floor to zero");

        _buyOn(t, alice, 1 ether, 0);
        assertGt(t.balanceOf(alice), 0);
        _sellOn(t, alice, t.balanceOf(alice) / 2, 0);
        _assertSolventOn(t);
    }

    /// The smallest launch there is: one whole token.
    function test_Edge_CreateWithASingleToken() public {
        vm.prank(creator);
        FolioToken t = FolioToken(factory.createToken("One", "ONE", 1));

        assertEq(t.curveSupply(), UNIT);
        assertEq(t.currentPrice(), 2 ether, "one token backed by a 2 ETH virtual reserve");

        _buyOn(t, alice, 1 ether, 0);
        assertGt(t.balanceOf(alice), 0);
        assertLt(t.balanceOf(alice), UNIT, "the curve can never hand over its last token");
        _assertSolventOn(t);
    }

    /// A supply the virtual reserve cannot price: the opening price would floor
    /// to zero and the first buyer would be handed tokens for nothing.
    function test_Edge_CreateWithSupplyOutrunningTheVirtualReserve() public {
        CurveConfig memory cfg = _config();
        cfg.virtualEthReserve = factory.MIN_VIRTUAL_ETH_RESERVE(); // 1e12 wei
        vm.prank(owner);
        factory.setDefaultConfig(cfg);

        vm.prank(creator);
        vm.expectRevert(FolioFactory.SupplyTooLargeForCurve.selector);
        factory.createToken("Dust", "DST", 1e12 + 1);

        // Exactly at the limit the opening price is one wei, and that is allowed.
        vm.prank(creator);
        FolioToken t = FolioToken(factory.createToken("Dust", "DST", 1e12));
        assertEq(t.currentPrice(), 1);
    }

    /// Every configuration bound, walked one step past its edge in both
    /// directions where both exist.
    function test_Edge_CreateWithOutOfRangeConfiguration() public {
        vm.startPrank(owner);

        CurveConfig memory cfg = _config();
        cfg.feeBps = factory.MAX_FEE_BPS() + 1;
        vm.expectRevert(FolioFactory.FeeTooHigh.selector);
        factory.setDefaultConfig(cfg);

        cfg = _config();
        cfg.virtualEthReserve = factory.MIN_VIRTUAL_ETH_RESERVE() - 1;
        vm.expectRevert(FolioFactory.InvalidVirtualReserve.selector);
        factory.setDefaultConfig(cfg);

        cfg = _config();
        cfg.virtualEthReserve = factory.MAX_VIRTUAL_ETH_RESERVE() + 1;
        vm.expectRevert(FolioFactory.InvalidVirtualReserve.selector);
        factory.setDefaultConfig(cfg);

        cfg = _config();
        cfg.virtualEthReserve = 0;
        vm.expectRevert(FolioFactory.InvalidVirtualReserve.selector);
        factory.setDefaultConfig(cfg);

        cfg = _config();
        cfg.maxReserveCap = factory.MIN_RESERVE_CAP() - 1;
        cfg.graduationThreshold = 0;
        vm.expectRevert(FolioFactory.InvalidReserveCap.selector);
        factory.setDefaultConfig(cfg);

        cfg = _config();
        cfg.maxReserveCap = factory.MAX_RESERVE_CAP() + 1;
        vm.expectRevert(FolioFactory.InvalidReserveCap.selector);
        factory.setDefaultConfig(cfg);

        cfg = _config();
        cfg.maxReserveCap = type(uint256).max;
        vm.expectRevert(FolioFactory.InvalidReserveCap.selector);
        factory.setDefaultConfig(cfg);

        cfg = _config();
        cfg.graduationThreshold = cfg.maxReserveCap + 1;
        vm.expectRevert(FolioFactory.InvalidGraduationThreshold.selector);
        factory.setDefaultConfig(cfg);

        cfg = _config();
        cfg.priceMoveAlertBps = factory.MIN_PRICE_MOVE_ALERT_BPS() - 1;
        vm.expectRevert(FolioFactory.InvalidPriceMoveAlert.selector);
        factory.setDefaultConfig(cfg);

        vm.stopPrank();
    }

    /// The extremes that *are* admissible, each one launched and traded so the
    /// bound is shown to be usable rather than merely accepted.
    function test_Edge_CreateAtEveryAdmissibleExtreme() public {
        CurveConfig memory cfg = CurveConfig({
            virtualEthReserve: factory.MAX_VIRTUAL_ETH_RESERVE(),
            maxReserveCap: factory.MAX_RESERVE_CAP(),
            graduationThreshold: factory.MAX_RESERVE_CAP(),
            feeBps: factory.MAX_FEE_BPS(),
            priceMoveAlertBps: factory.MIN_PRICE_MOVE_ALERT_BPS(),
            // The harshest admissible opening window: as long as the factory
            // allows, throttled as hard as it allows.
            sniperWindowSeconds: factory.MAX_SNIPER_WINDOW_SECONDS(),
            sniperMaxEthPerWallet: factory.MIN_SNIPER_MAX_ETH_PER_WALLET()
        });
        vm.prank(owner);
        factory.setDefaultConfig(cfg);

        vm.prank(creator);
        FolioToken big = FolioToken(factory.createToken("Big", "BIG", factory.MAX_WHOLE_SUPPLY()));

        // Past that window, so what follows measures the curve at its extremes
        // rather than the cap. That the window expires cleanly at its own maximum
        // is the part being shown here; `FolioAntiSniper.t.sol` covers what it
        // does while open.
        vm.warp(block.timestamp + factory.MAX_SNIPER_WINDOW_SECONDS() + 1);

        vm.deal(alice, 100_000 ether);
        _buyOn(big, alice, 50_000 ether, 0);
        assertGt(big.balanceOf(alice), 0);
        _sellOn(big, alice, big.balanceOf(alice) / 2, 0);
        _assertSolventOn(big);

        // And the other end: the smallest everything.
        cfg = CurveConfig({
            virtualEthReserve: factory.MIN_VIRTUAL_ETH_RESERVE(),
            maxReserveCap: factory.MIN_RESERVE_CAP(),
            graduationThreshold: 0,
            feeBps: 0,
            priceMoveAlertBps: 0,
            sniperWindowSeconds: 0,
            sniperMaxEthPerWallet: 0
        });
        vm.prank(owner);
        factory.setDefaultConfig(cfg);

        vm.prank(creator);
        FolioToken small = FolioToken(factory.createToken("Small", "SML", 1));

        _buyOn(small, bob, 0.0005 ether, 0);
        assertGt(small.balanceOf(bob), 0);
        _sellOn(small, bob, small.balanceOf(bob), 0);
        _assertSolventOn(small);
    }

    /// A zero fee is admissible, and the reserve then takes the whole payment.
    function test_Edge_ZeroFeeLaunchChargesNothing() public {
        CurveConfig memory cfg = _config();
        cfg.feeBps = 0;
        vm.prank(owner);
        factory.setDefaultConfig(cfg);
        FolioToken t = _create(SUPPLY);

        _buyOn(t, alice, 1 ether, 0);
        assertEq(t.ethReserve(), 1 ether, "a zero-fee buy is all reserve");
        assertEq(t.feesAccrued(), 0);

        _sellOn(t, alice, t.balanceOf(alice), 0);
        assertEq(t.feesAccrued(), 0, "a zero-fee sell accrues nothing either");
        _assertSolventOn(t);
    }

    /// Name and symbol at their length limits, and one byte past.
    function test_Edge_CreateWithBoundaryLengthStrings() public {
        string memory name64 = "0123456789012345678901234567890123456789012345678901234567890123";
        string memory symbol16 = "0123456789012345";
        assertEq(bytes(name64).length, 64);
        assertEq(bytes(symbol16).length, 16);

        vm.prank(creator);
        FolioToken t = FolioToken(factory.createToken(name64, symbol16, 1000));
        assertEq(t.name(), name64);
        assertEq(t.symbol(), symbol16);

        vm.prank(creator);
        vm.expectRevert(FolioFactory.NameTooLong.selector);
        factory.createToken(string.concat(name64, "x"), symbol16, 1000);

        vm.prank(creator);
        vm.expectRevert(FolioFactory.SymbolTooLong.selector);
        factory.createToken(name64, string.concat(symbol16, "x"), 1000);
    }
}
