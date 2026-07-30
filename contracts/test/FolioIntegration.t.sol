// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";
import {FolioTestBase} from "./helpers/FolioTestBase.sol";

/**
 * Stage 4, part six: the whole thing, end to end.
 *
 * Everything else in this suite tests a function, a property, or an attack. This
 * file runs a launch the way a launch actually goes — created, bought into by
 * several people, partly sold, fees claimed, paused and resumed, wound down —
 * and checks after every single step that the contract's state is what the curve
 * says it should be.
 *
 * The expected values are tracked in the test's own variables, accumulated from
 * the independently written {_predictBuy} / {_predictSell} in the base contract.
 * Nothing here reads a figure off the token and compares it to itself: at every
 * checkpoint there are two independently derived numbers, and they have to
 * match.
 */
contract FolioIntegrationTest is FolioTestBase {
    // Running expectations, accumulated by the test rather than read from state.
    uint256 internal expectedReserve;
    uint256 internal expectedFees;
    uint256 internal expectedSupply;
    uint256 internal expectedContractBalance;

    /// What each participant has put in and taken out, tracked independently.
    mapping(address => uint256) internal spent;
    mapping(address => uint256) internal received;
    /// Tokens each participant bought off the curve, before any later sale, so
    /// the price they paid can be recovered after their balance has moved.
    mapping(address => uint256) internal bought;

    /**
     * The full lifecycle of one launch, checked at every step.
     *
     * Five participants, eleven state-changing operations, and a complete wind
     * down. Every buy and every sell is predicted before it is executed and the
     * prediction is checked after.
     */
    function test_EndToEnd_AFullLaunchLifecycle() public {
        // ---------------------------------------------------------------
        // 1. Creation
        // ---------------------------------------------------------------
        FolioToken t = _createAs(creator, "Midnight Kettle", "KETL", SUPPLY);
        assertEq(t.totalSupply(), 0);
        assertEq(t.ethReserve(), 0);
        assertEq(t.currentPrice(), 2 ether / SUPPLY);
        _checkpoint(t, "after creation");

        // ---------------------------------------------------------------
        // 2. Four buyers come in at different sizes
        // ---------------------------------------------------------------
        _trackedBuy(t, alice, 0.75 ether);
        _checkpoint(t, "after alice's buy");

        _trackedBuy(t, bob, 1.2 ether);
        _checkpoint(t, "after bob's buy");

        _trackedBuy(t, carol, 0.3 ether);
        _checkpoint(t, "after carol's buy");

        _trackedBuy(t, dave, 0.05 ether);
        _checkpoint(t, "after dave's buy");

        // Each later buyer got fewer tokens per wei than the one before them —
        // measured as a rate, since they all staked different amounts.
        assertLt(_tokensPerWei(bob), _tokensPerWei(alice), "bob did not pay more than alice");
        assertLt(_tokensPerWei(carol), _tokensPerWei(bob), "carol did not pay more than bob");
        assertLt(_tokensPerWei(dave), _tokensPerWei(carol), "dave did not pay more than carol");

        // ---------------------------------------------------------------
        // 3. A partial sell, then a buy on top of it
        // ---------------------------------------------------------------
        _trackedSell(t, alice, t.balanceOf(alice) / 2);
        _checkpoint(t, "after alice sells half");

        _trackedBuy(t, eve, 0.4 ether);
        _checkpoint(t, "after eve buys the dip");

        // ---------------------------------------------------------------
        // 4. The creator takes their fees out mid-life
        // ---------------------------------------------------------------
        uint256 obligationBefore = t.getOutstandingSellObligation();
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        uint256 claimed = t.claimFees();

        assertEq(claimed, expectedFees, "the creator was paid the wrong amount");
        assertEq(creator.balance, creatorBefore + expectedFees);
        assertEq(
            t.getOutstandingSellObligation(), obligationBefore, "claiming fees moved the curve"
        );
        expectedContractBalance -= expectedFees;
        expectedFees = 0;
        _checkpoint(t, "after the creator claims");

        // ---------------------------------------------------------------
        // 5. The platform pauses and resumes
        // ---------------------------------------------------------------
        vm.prank(owner);
        factory.pause();

        vm.prank(bob);
        vm.expectRevert(FolioToken.TradingPaused.selector);
        t.buy{value: 1 ether}(0);

        // Every view still answers, and answers correctly, while stopped.
        assertEq(t.ethReserve(), expectedReserve, "the pause disturbed the reserve");
        assertGt(t.currentPrice(), 0);
        _checkpoint(t, "while paused");

        vm.prank(owner);
        factory.unpause();
        _checkpoint(t, "after resuming");

        // ---------------------------------------------------------------
        // 6. Tokens change hands off-curve
        // ---------------------------------------------------------------
        uint256 gift = t.balanceOf(dave);
        uint256 eveBefore = t.balanceOf(eve);
        uint256 priceBefore = t.currentPrice();
        uint256 obligationBeforeTransfer = t.getOutstandingSellObligation();

        vm.prank(dave);
        t.transfer(eve, gift);

        // A transfer moves ownership and touches nothing else: the curve does
        // not know or care who holds what.
        assertEq(t.balanceOf(dave), 0);
        assertEq(t.balanceOf(eve), eveBefore + gift);
        assertEq(t.currentPrice(), priceBefore, "a transfer moved the price");
        assertEq(
            t.getOutstandingSellObligation(),
            obligationBeforeTransfer,
            "a transfer changed what the curve owes"
        );
        // The checkpoint below re-checks reserve, fees and supply are untouched.
        _checkpoint(t, "after a transfer between holders");

        // ---------------------------------------------------------------
        // 7. Everybody exits
        // ---------------------------------------------------------------
        address[5] memory everyone = [alice, bob, carol, dave, eve];
        for (uint256 i = 0; i < everyone.length; i++) {
            uint256 held = t.balanceOf(everyone[i]);
            if (held == 0) continue;
            _trackedSell(t, everyone[i], held);
            _checkpoint(t, "mid wind-down");
        }

        // ---------------------------------------------------------------
        // 8. The final state, checked against first principles
        // ---------------------------------------------------------------
        assertEq(t.totalSupply(), 0, "somebody is still holding tokens");
        assertEq(t.tokensSold(), 0, "the curve still thinks tokens are outstanding");
        assertEq(t.curveTokenReserve(), SUPPLY * UNIT, "inventory is not whole again");
        assertEq(t.getOutstandingSellObligation(), 0, "the curve still owes somebody");

        // The reserve is empty but for rounding dust that could only ever have
        // accumulated in the curve's favour.
        assertLe(t.ethReserve(), 10, "the reserve did not empty");
        assertEq(t.ethReserve(), expectedReserve, "the reserve is not what the curve predicts");

        // Conservation, over the entire life of the launch: every wei anyone
        // ever sent is now either in somebody's wallet or still in the contract.
        uint256 totalSpent;
        uint256 totalReceived;
        for (uint256 i = 0; i < everyone.length; i++) {
            totalSpent += spent[everyone[i]];
            totalReceived += received[everyone[i]];
        }
        assertEq(
            totalSpent,
            totalReceived + claimed + address(t).balance,
            "ETH went somewhere unaccounted for over the launch's lifetime"
        );

        console.log("total put in by traders (wei) ", totalSpent);
        console.log("total taken out by them (wei) ", totalReceived);
        console.log("claimed by the creator  (wei) ", claimed);
        console.log("left in the contract    (wei) ", address(t).balance);
        console.log("  of which reserve dust      ", t.ethReserve());
        console.log("  of which unclaimed fees    ", t.feesAccrued());

        _assertSolventOn(t);
    }

    /**
     * The same shape of run, but across three launches at once, with the trades
     * interleaved so no launch ever gets a clean stretch to itself.
     *
     * Clones share one implementation contract. This is the run that would catch
     * state leaking between them.
     */
    function test_EndToEnd_ThreeLaunchesInterleaved() public {
        FolioToken a = _createAs(makeAddr("creatorA"), "Alpha", "ALP", 100_000);
        FolioToken b = _createAs(makeAddr("creatorB"), "Beta", "BET", 750_000);
        FolioToken c = _createAs(makeAddr("creatorC"), "Gamma", "GAM", 2_000);

        uint256[3] memory sentTo;

        // Round one.
        sentTo[0] += 1 ether;
        _buyOn(a, alice, 1 ether, 0);
        sentTo[1] += 0.5 ether;
        _buyOn(b, alice, 0.5 ether, 0);
        sentTo[2] += 2 ether;
        _buyOn(c, bob, 2 ether, 0);

        // Round two, different actors.
        sentTo[0] += 0.25 ether;
        _buyOn(a, carol, 0.25 ether, 0);
        sentTo[1] += 1.5 ether;
        _buyOn(b, dave, 1.5 ether, 0);
        sentTo[2] += 0.1 ether;
        _buyOn(c, eve, 0.1 ether, 0);

        // Partial exits, interleaved.
        uint256[3] memory paidOut;
        paidOut[0] += _sellOn(a, alice, a.balanceOf(alice) / 3, 0);
        paidOut[1] += _sellOn(b, dave, b.balanceOf(dave) / 2, 0);
        paidOut[2] += _sellOn(c, bob, c.balanceOf(bob) / 4, 0);

        // Each launch's books balance on their own.
        FolioToken[3] memory all = [a, b, c];
        for (uint256 i = 0; i < 3; i++) {
            assertEq(
                address(all[i]).balance,
                sentTo[i] - paidOut[i],
                "a launch holds the wrong amount of ETH"
            );
            assertEq(
                all[i].ethReserve() + all[i].feesAccrued(),
                sentTo[i] - paidOut[i],
                "a launch's internal accounting disagrees with its balance"
            );
            _assertSolventOn(all[i]);
        }

        // And their curve terms never crossed over.
        assertEq(a.curveSupply(), 100_000 * UNIT);
        assertEq(b.curveSupply(), 750_000 * UNIT);
        assertEq(c.curveSupply(), 2_000 * UNIT);
        assertTrue(a.creator() != b.creator() && b.creator() != c.creator());
    }

    /**
     * A launch that runs all the way to graduation and then lives out its life
     * as a sell-only market.
     */
    function test_EndToEnd_ThroughGraduationAndOut() public {
        FolioToken t = _createAs(creator, "Midnight Kettle", "KETL", SUPPLY);

        // Buy up to just under the threshold in stages.
        _buyOn(t, alice, 1.5 ether, 0);
        _buyOn(t, bob, 1.5 ether, 0);
        assertFalse(t.graduated(), "graduated too early");
        assertGt(t.ethHeadroom(), 0);

        // The buy that crosses it overshoots deliberately and is refunded.
        uint256 carolBefore = carol.balance;
        _buyOn(t, carol, 5 ether, 0);

        assertTrue(t.graduated(), "the threshold was crossed without graduating");
        assertEq(t.ethReserve(), 4 ether, "graduation did not land exactly on the threshold");
        assertLt(carolBefore - carol.balance, 5 ether, "the overshoot was not refunded");

        // Buying is closed to everyone, including the people already in.
        address[3] memory holders = [alice, bob, carol];
        for (uint256 i = 0; i < holders.length; i++) {
            vm.prank(holders[i]);
            vm.expectRevert(FolioToken.CurveClosed.selector);
            t.buy{value: 0.1 ether}(0);
        }

        // Selling is not, and the whole book can unwind.
        uint256 out;
        for (uint256 i = 0; i < holders.length; i++) {
            out += _sellOn(t, holders[i], t.balanceOf(holders[i]), 0);
            _assertSolventOn(t);
        }

        assertEq(t.totalSupply(), 0, "somebody was trapped after graduation");
        assertApproxEqRel(out, 4 ether * 99 / 100, 1e15, "the unwind did not return the reserve");

        // The creator's fees survived all of it.
        vm.prank(creator);
        assertGt(t.claimFees(), 0);
        _assertSolventOn(t);
    }

    // =======================================================================
    // Helpers
    // =======================================================================

    /// Buys, predicting the outcome first and checking it after.
    function _trackedBuy(FolioToken t, address who, uint256 value) private {
        (uint256 wantTokens, uint256 wantNet, uint256 wantFee) = _predictBuy(t, value);
        uint256 heldBefore = t.balanceOf(who);

        uint256 got = _buyOn(t, who, value, 0);

        assertEq(got, wantTokens, "a buy settled away from the curve");
        assertEq(t.balanceOf(who), heldBefore + wantTokens);

        expectedReserve += wantNet;
        expectedFees += wantFee;
        expectedSupply += wantTokens;
        expectedContractBalance += value;
        spent[who] += value;
        bought[who] += wantTokens;
    }

    /// Sells, predicting the outcome first and checking it after.
    function _trackedSell(FolioToken t, address who, uint256 amount) private {
        (uint256 wantOut, uint256 wantGross, uint256 wantFee) = _predictSell(t, amount);
        uint256 heldBefore = t.balanceOf(who);
        uint256 walletBefore = who.balance;

        uint256 got = _sellOn(t, who, amount, 0);

        assertEq(got, wantOut, "a sell settled away from the curve");
        assertEq(t.balanceOf(who), heldBefore - amount);
        assertEq(who.balance, walletBefore + wantOut);

        expectedReserve -= wantGross;
        expectedFees += wantFee;
        expectedSupply -= amount;
        expectedContractBalance -= wantOut;
        received[who] += wantOut;
    }

    /// Re-checks the whole of the contract's state against the running
    /// expectations, plus the solvency invariant, at a named point in the run.
    function _checkpoint(FolioToken t, string memory label) private view {
        assertEq(t.ethReserve(), expectedReserve, string.concat("reserve wrong ", label));
        assertEq(t.feesAccrued(), expectedFees, string.concat("fees wrong ", label));
        assertEq(t.totalSupply(), expectedSupply, string.concat("supply wrong ", label));
        assertEq(t.tokensSold(), expectedSupply, string.concat("tokensSold wrong ", label));
        assertEq(
            address(t).balance,
            expectedContractBalance,
            string.concat("contract balance wrong ", label)
        );
        _assertSolventOn(t);
    }

    /**
     * Token units bought per wei staked, scaled by 1e18.
     *
     * Comparing raw balances would not say anything about price, since these
     * buyers staked different amounts — the rate is what makes "bob paid more
     * than alice" a claim about the curve rather than about trade size. Taken
     * from what each buyer received at the time, so it survives their later
     * sales.
     */
    function _tokensPerWei(address who) private view returns (uint256) {
        return (bought[who] * 1e18) / spent[who];
    }
}
