// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";
import {FolioTestBase} from "./helpers/FolioTestBase.sol";
import {RogueLauncher} from "./helpers/Adversaries.sol";

/**
 * Stage 4, appendix: the three branches ordinary use cannot reach.
 *
 * `FolioToken` carries a handful of guards its own documentation describes as
 * unreachable — the reserve shortfall, the price-of-zero check, the refund
 * clamp. They are the right thing to have written, and they are also the last
 * three uncovered branches in the contract, so leaving them alone would mean
 * signing off a coverage number without knowing whether the gap was defensive
 * code or a real hole.
 *
 * Two of the three turn out to be reachable, given a state the factory would
 * never produce, and are tested here properly. The third is not reachable at
 * all — it is provably dead — and rather than leave that as an assertion in a
 * comment, {testFuzz_TheRefundClampIsUnreachable} attacks the arithmetic
 * directly and fails if the fuzzer ever finds an input that would trip it.
 *
 * None of this is normal-path testing and none of it should be read as such.
 * It is here so that the coverage report has no unexplained holes in it.
 */
contract FolioDefensiveBranchesTest is FolioTestBase {
    // =======================================================================
    // 1. ReserveShortfall — reachable only by corrupting storage
    // =======================================================================

    /**
     * `sell` refuses to settle if the curve asks the reserve for more than it
     * holds. By the curve's algebra that cannot happen: buying back the whole
     * circulating supply costs exactly `ethReserve`, and any single sell is a
     * subset of that.
     *
     * So the only way to see this branch is to manufacture the state it exists
     * for — write a false `ethReserve` straight into storage and check the
     * contract notices. What that establishes is the thing worth establishing:
     * if the curve's accounting is ever wrong, the failure is a named revert
     * with both numbers attached, rather than an arithmetic underflow or, far
     * worse, a payout that quietly strands the next seller.
     */
    function test_Defensive_ReserveShortfallIsCaughtRatherThanUnderflowing() public {
        _buy(alice, 1 ether, 0);
        uint256 held = token.balanceOf(alice);

        // The state as it should be: fully covered.
        assertGe(token.ethReserve(), token.getOutstandingSellObligation());

        // Now break it. Slot 7 is `ethReserve` — see `SLOT_ETH_RESERVE` in the
        // base contract, confirmed against `forge inspect`.
        vm.store(address(token), bytes32(SLOT_ETH_RESERVE), bytes32(uint256(1)));
        assertEq(token.ethReserve(), 1, "the corruption did not take");

        // The *gross* is what the reserve is asked for — the second return, not
        // the seller's net payout.
        (, uint256 expectedGross,) = _predictSell(token, held);
        assertGt(expectedGross, 1, "the corrupted state is not actually a shortfall");

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(FolioToken.ReserveShortfall.selector, expectedGross, 1)
        );
        token.sell(held, 0);

        // The trade did not settle: no burn, no payout, nothing half-done.
        assertEq(token.balanceOf(alice), held, "tokens were burned by a refused trade");
        assertEq(token.ethReserve(), 1);
    }

    /// The guard is a floor, not a blanket refusal: with the reserve corrupted
    /// to a smaller-but-still-sufficient number, a small sell still settles.
    function test_Defensive_ShortfallGuardStillAllowsWhatTheReserveCanCover() public {
        _buy(alice, 1 ether, 0);
        uint256 held = token.balanceOf(alice);

        uint256 realReserve = token.ethReserve();
        vm.store(address(token), bytes32(SLOT_ETH_RESERVE), bytes32(realReserve / 2));

        // A sale small enough for the halved reserve goes through.
        uint256 small = held / 100;
        (, uint256 gross,) = _predictSell(token, small);
        assertLt(gross, realReserve / 2, "the test's own premise does not hold");

        uint256 got = _sell(alice, small, 0);
        assertGt(got, 0, "a covered sale was refused");
    }

    // =======================================================================
    // 2. A price of zero — reachable only outside the factory
    // =======================================================================

    /**
     * `_signalLargeMove` bails out when either price reads zero, which would
     * otherwise be a division by zero that reverts an already-settled trade.
     *
     * Through `FolioFactory` that is unreachable: `createToken` refuses a supply
     * larger than the virtual reserve backing it, precisely so the opening price
     * cannot floor to zero. But `initialize` is externally reachable on any
     * fresh clone and only re-checks the fields that would break the *curve*, so
     * a clone made outside the factory can hold a configuration the factory
     * would have refused — which is exactly the case this guard is written for.
     *
     * The clone below has a one-wei virtual reserve against a thousand-token
     * supply, so its marginal price floors to zero. The trade still settles; the
     * monitoring signal simply declines to divide by it.
     */
    function test_Defensive_AZeroPriceDoesNotRevertASettledTrade() public {
        RogueLauncher rogue = new RogueLauncher();

        CurveConfig memory degenerate = CurveConfig({
            virtualEthReserve: 1, // one wei, against a 1000-token supply
            maxReserveCap: 1 ether,
            graduationThreshold: 0,
            feeBps: 100,
            priceMoveAlertBps: 10_000, // the signal must be *on* to reach the guard
            sniperWindowSeconds: 0,
            sniperMaxEthPerWallet: 0
        });

        FolioToken odd = FolioToken(
            rogue.launch(factory.implementation(), creator, "Degenerate", "DGN", 1000, degenerate)
        );

        assertEq(odd.currentPrice(), 0, "the premise fails: this price is not zero");
        assertFalse(factory.isFolioToken(address(odd)), "this should not be a registered launch");

        // The trade settles. Without the guard this is a panic, not a trade.
        vm.prank(alice);
        uint256 got = odd.buy{value: 100}(0);

        assertGt(got, 0, "the buy did not settle");
        assertEq(odd.tokensSold(), got);
        assertEq(odd.ethReserve(), 99, "the reserve did not take the post-fee ETH");
        assertGt(odd.currentPrice(), 0, "the price should be non-zero after the buy");
        _assertSolventOn(odd);
    }

    /// The factory refuses to produce that configuration in the first place,
    /// which is what makes the guard above defence in depth rather than the
    /// only thing standing in the way.
    function test_Defensive_TheFactoryRefusesTheConfigurationThatCausesIt() public {
        CurveConfig memory cfg = _config();
        cfg.virtualEthReserve = factory.MIN_VIRTUAL_ETH_RESERVE();
        vm.prank(owner);
        factory.setDefaultConfig(cfg);

        // One token past what the virtual reserve can price.
        uint256 tooMany = cfg.virtualEthReserve + 1;
        vm.prank(creator);
        vm.expectRevert(FolioFactory.SupplyTooLargeForCurve.selector);
        factory.createToken("Degenerate", "DGN", tooMany);
    }

    // =======================================================================
    // 3. The refund clamp — dead code, and provably so
    // =======================================================================

    /**
     * FINDING (informational) — `if (gross > ethIn) gross = ethIn;` in
     * `_quoteBuy` is unreachable. It is dead code, not a latent bug.
     *
     * The clamp guards the re-derived gross in the headroom path. When a buy
     * would overshoot the ceiling, `netEth` is cut down to `headroom` and the
     * gross that nets to it is recomputed rounding up; the clamp is there in
     * case that rounding pushes the figure past what the buyer actually sent.
     * It cannot.
     *
     * Writing `f` for `feeBps`, `B` for `BPS` and `E` for `ethIn`:
     *
     *   netEth  = E - floor(E*f/B)
     *   the clamp only runs when netEth > headroom, so headroom = netEth - k
     *   for some k >= 1
     *   gross   = ceil((netEth - k) * B / (B - f))
     *
     * and `ceil(a/b) <= E` exactly when `a <= E*b`, so `gross <= E` iff
     *
     *   (netEth - k) * B <= E * (B - f)
     *
     * Write `E*f = qB + r` with `0 <= r < B`, so `floor(E*f/B) = q`. Then
     *
     *   LHS = (E - q - k)*B = E*B - qB - kB
     *   RHS = E*B - E*f     = E*B - qB - r
     *
     * and the inequality reduces to `r <= k*B`, which holds for every input
     * because `r < B` and `k >= 1`. There is no `ethIn`, no `feeBps` and no
     * headroom for which the clamp fires.
     *
     * The test below is that proof made executable: it reproduces `_quoteBuy`'s
     * arithmetic over the full admissible range and fails if the fuzzer ever
     * finds a case where the clamp would have been needed. Left in the contract
     * as written — removing a correct guard to chase a coverage percentage is a
     * bad trade, and the branch costs one comparison on the rare path.
     */
    function testFuzz_TheRefundClampIsUnreachable(uint256 ethIn, uint16 feeBps, uint256 shortfall)
        public
        pure
    {
        ethIn = bound(ethIn, 1, 1e30);
        feeBps = uint16(bound(feeBps, 0, 500)); // MAX_FEE_BPS
        uint256 bps = 10_000;

        uint256 fee = (ethIn * feeBps) / bps;
        uint256 netEth = ethIn - fee;

        // The clamp only runs when the headroom bites, i.e. headroom < netEth.
        vm.assume(netEth > 0);
        uint256 headroom = netEth - bound(shortfall, 1, netEth);

        uint256 gross = Math.mulDiv(headroom, bps, bps - feeBps, Math.Rounding.Ceil);

        assertLe(gross, ethIn, "the refund clamp is reachable after all");
    }

    /// The same claim checked end to end against the live contract rather than
    /// against a reproduction of its arithmetic: a buy that overshoots the
    /// ceiling never charges more than was sent, and the refund always balances.
    function testFuzz_AClampedBuyNeverOverchargesTheBuyer(uint256 ethIn, uint16 fee) public {
        CurveConfig memory cfg = _config();
        cfg.feeBps = uint16(bound(fee, 0, factory.MAX_FEE_BPS()));
        vm.prank(owner);
        factory.setDefaultConfig(cfg);
        FolioToken t = _create(SUPPLY);

        // Big enough to overshoot the 4 ETH graduation threshold every time.
        ethIn = bound(ethIn, 4.5 ether, 10_000 ether);
        vm.deal(alice, ethIn);

        uint256 before = alice.balance;
        (uint256 quoted, uint256 quotedSpend, uint256 quotedRefund) = t.getBuyQuote(ethIn);
        assertGt(quotedRefund, 0, "this buy was supposed to overshoot");
        assertEq(quotedSpend + quotedRefund, ethIn, "the quote does not balance");

        uint256 got = _buyOn(t, alice, ethIn, 0);
        uint256 actuallySpent = before - alice.balance;

        assertEq(got, quoted, "settlement drifted from the quote");
        assertLe(actuallySpent, ethIn, "the buyer was charged more than they sent");
        assertEq(actuallySpent, quotedSpend, "the refund did not match the quote");
        assertEq(t.ethReserve(), 4 ether, "the clamp did not land on the ceiling");
        _assertSolventOn(t);
    }
}
