// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";
import {FolioHandler} from "./helpers/FolioHandler.sol";

/**
 * Stage 4, part three: the properties that must hold after *every* call, in
 * every order, forever.
 *
 * The stateless fuzz suite asks "is this function right for this input". This
 * one asks the harder question: does any *sequence* of calls — buys, sells,
 * transfers, fee claims, an emergency stop in the middle, ETH forced in from
 * outside — leave the contract in a state it should not be able to reach.
 * Foundry generates those sequences at random and re-checks every `invariant_`
 * below after each individual call, so a violation is caught at the call that
 * caused it and the shrunk sequence names it.
 *
 * The headline invariant is {invariant_ReserveCoversEveryOutstandingSell}: no
 * ordering of trades can leave the reserve unable to buy back every circulating
 * token. That is the promise the whole design rests on, and it is the reason
 * this file exists.
 *
 * `fail_on_revert` is on for these runs (see `foundry.toml`), so the handler has
 * to filter its own preconditions. The call summary printed with `-vv` is worth
 * reading: it is what distinguishes a genuine pass from a run that never
 * managed to trade.
 */
contract FolioInvariantTest is Test {
    FolioFactory internal factory;
    FolioToken internal token;
    FolioHandler internal handler;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");

    uint256 internal constant SUPPLY = 1_000_000;
    uint256 internal constant BPS = 10_000;

    function setUp() public {
        CurveConfig memory config = CurveConfig({
            virtualEthReserve: 2 ether,
            // Graduation off and a generous cap, so runs are not cut short by the
            // curve closing after a handful of buys. The ceiling behaviour has its
            // own dedicated tests; what this file needs is a long trading life.
            maxReserveCap: 500 ether,
            graduationThreshold: 0,
            feeBps: 100,
            priceMoveAlertBps: 10_000,
            // Off. The handler trades from a small set of actors on a fast-forward
            // clock, so a live window would throttle them into a much narrower
            // slice of the state space than the invariants are meant to sweep.
            sniperWindowSeconds: 0,
            sniperMaxEthPerWallet: 0,
            migrator: address(0)
        });

        factory = new FolioFactory(owner, config);
        vm.prank(creator);
        token = FolioToken(factory.createToken("Midnight Kettle", "KETL", SUPPLY));

        address[] memory actors = new address[](5);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("carol");
        actors[3] = makeAddr("dave");
        actors[4] = makeAddr("eve");

        // `vm.prank` debits a value-bearing call from the pranked address, so the
        // actors need the ETH. The handler keeps a float of its own purely to
        // fund {FolioHandler-forceFeed}.
        for (uint256 i = 0; i < actors.length; i++) {
            vm.deal(actors[i], 100_000 ether);
        }

        handler = new FolioHandler(factory, token, actors);
        vm.deal(address(handler), 1_000 ether);

        targetContract(address(handler));

        // Keep the fuzzer off the contracts themselves: it should only reach them
        // through the handler, which is where the ghost accounting lives.
        excludeContract(address(token));
        excludeContract(address(factory));
    }

    // =======================================================================
    // Solvency — the reason this file exists
    // =======================================================================

    /**
     * The promise: whatever has happened, the reserve can still buy back every
     * token in circulation.
     *
     * `getOutstandingSellObligation` deliberately computes that figure the long
     * way round, off the curve, rather than returning `ethReserve` — so this is a
     * real comparison of two independently derived numbers and not a tautology.
     */
    function invariant_ReserveCoversEveryOutstandingSell() public view {
        assertGe(
            token.getReserveBalance(),
            token.getOutstandingSellObligation(),
            "reserve cannot cover the outstanding sell obligation"
        );
    }

    /// The same property read through the health gauge a monitor would watch.
    function invariant_ReserveHealthNeverDipsBelowFullyCovered() public view {
        assertGe(token.reserveHealthBps(), BPS, "reserve health fell below fully covered");
    }

    /**
     * The contract actually holds the ETH it says it does. `ethReserve` and
     * `feesAccrued` are two separate claims on the same balance, and the balance
     * has to cover both at once — otherwise paying one would strand the other.
     */
    function invariant_BalanceCoversReserveAndFeesTogether() public view {
        assertGe(
            address(token).balance,
            token.ethReserve() + token.feesAccrued(),
            "the contract has promised more ETH than it holds"
        );
    }

    /// Fees are never payable out of the reserve, and the reserve is never
    /// payable out of fees. The two never overlap.
    function invariant_FeesAndReserveAreDisjoint() public view {
        uint256 claims = token.ethReserve() + token.feesAccrued();
        assertLe(claims, address(token).balance, "the two claims overlap");
    }

    // =======================================================================
    // Supply accounting
    // =======================================================================

    /// The ERC20's idea of supply and the curve's idea of supply are the same
    /// number. A drift here is what would let someone sell tokens the curve
    /// never issued.
    function invariant_SupplyMatchesTheCurve() public view {
        assertEq(token.totalSupply(), token.tokensSold(), "supply and curve accounting diverged");
    }

    /// The curve cannot issue more than it has.
    function invariant_IssuanceNeverExceedsSupply() public view {
        assertLe(token.tokensSold(), token.curveSupply(), "the curve over-issued");
        assertGt(token.curveTokenReserve(), 0, "the curve sold its last token");
    }

    /// Everyone's holdings add up to the supply — no token exists outside an
    /// account, and no account holds one that was never minted.
    function invariant_HoldingsSumToSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            sum += token.balanceOf(handler.actorAt(i));
        }
        sum += token.balanceOf(address(handler));
        assertEq(sum, token.totalSupply(), "balances do not add up to the supply");
    }

    // =======================================================================
    // The ceiling
    // =======================================================================

    function invariant_ReserveStaysUnderItsCap() public view {
        assertLe(token.ethReserve(), token.maxReserveCap(), "the reserve broke through its cap");
    }

    /**
     * Graduation is one-way: once the latch is set, buying stays closed.
     *
     * Stated against `getBuyQuote` rather than against `ethHeadroom`. Those two
     * disagree on a graduated curve whose reserve has since been sold back down
     * — `ethHeadroom` is a reserve-against-ceiling reading and knows nothing
     * about the latch, so it reports room that `buy` will not honour. See
     * `test_Griefing_Finding_GraduationCanBeForcedAndIsIrreversible` in the
     * adversarial suite, which is where that gap is documented.
     *
     * This asserts the property that actually protects callers: the quote a
     * frontend prices against agrees with what `buy` will do.
     */
    function invariant_GraduationClosesTheCurveToBuys() public view {
        if (!token.graduated()) return;

        (uint256 tokensOut,, uint256 refund) = token.getBuyQuote(1 ether);
        assertEq(tokensOut, 0, "a graduated curve quoted a non-zero purchase");
        assertEq(refund, 1 ether, "a graduated curve did not quote a full refund");
    }

    // =======================================================================
    // Value conservation — nobody gets out more than went in
    // =======================================================================

    /**
     * Traders, taken together, can never take more ETH out of this contract than
     * they put into it.
     *
     * Individually they can of course profit — buying before someone else pushes
     * the price up is what a market *is*. What must never happen is the group as
     * a whole ending up ahead, because the only place that ETH could come from is
     * the reserve backing everyone else's ability to sell.
     */
    function invariant_TradersNeverExtractMoreThanTheyPutIn() public view {
        assertLe(
            handler.tradersOut(),
            handler.tradersIn(),
            "traders collectively extracted ETH from the curve"
        );
    }

    /**
     * Exact conservation: every wei that ever entered this contract is either
     * still in it, was paid to a seller, or was claimed by the creator.
     *
     * Stated as an equality rather than a bound, so a wei that leaked to a fourth
     * destination fails this even though every inequality above would still hold.
     */
    function invariant_EveryWeiIsAccountedFor() public view {
        assertEq(
            handler.tradersIn() + handler.forcedIn(),
            handler.tradersOut() + handler.feesClaimed() + address(token).balance,
            "ETH appeared in or vanished from the contract"
        );
    }

    /// Forced-in ETH is a gift to nobody: it never becomes reserve, and it never
    /// becomes claimable fees.
    function invariant_ForcedEthNeverBecomesSpendable() public view {
        assertLe(
            token.ethReserve() + token.feesAccrued(),
            handler.tradersIn(),
            "ETH forced in from outside was counted as reserve or fees"
        );
    }

    // =======================================================================
    // The curve itself
    // =======================================================================

    /**
     * `k` never falls. Every rounding decision in the contract resolves in the
     * reserve's favour, so numerical dust can only accumulate as surplus — and a
     * falling `k` would be exactly the signature of dust accumulating the other
     * way, which is how a curve becomes quietly insolvent over thousands of
     * trades rather than all at once.
     */
    function invariant_CurveProductNeverFalls() public view {
        assertGe(handler.currentK(), handler.highWaterK(), "the curve product fell");
    }

    /// The price is always a real number the frontend can show.
    function invariant_PriceIsAlwaysWellDefined() public view {
        assertGt(token.currentPrice(), 0, "the marginal price collapsed to zero");
    }

    // =======================================================================
    // Nobody is stuck
    // =======================================================================

    /**
     * Every holder can still get a quote, and the reserve can still honour it.
     *
     * "Can I sell?" is the question a holder actually cares about, and this is
     * the invariant form of it: for each account holding tokens, quoting the sale
     * of their entire balance must answer, and the reserve must be able to cover
     * what it answers.
     */
    function invariant_NoHolderIsStuck() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address holder = handler.actorAt(i);
            uint256 held = token.balanceOf(holder);
            if (held == 0) continue;

            uint256 payout = token.getSellPrice(held);
            assertLe(payout, token.ethReserve(), "a holder's exit exceeds the whole reserve");
        }
    }

    /// The immutable terms are immutable. Nothing any caller can do reaches them.
    function invariant_LaunchTermsNeverChange() public view {
        assertEq(token.virtualEthReserve(), 2 ether);
        assertEq(token.maxReserveCap(), 500 ether);
        assertEq(token.graduationThreshold(), 0);
        assertEq(token.feeBps(), 100);
        assertEq(token.creator(), creator);
        assertEq(token.factory(), address(factory));
        assertEq(token.curveSupply(), SUPPLY * 1e18);
    }

    // =======================================================================
    // Run census
    // =======================================================================

    /**
     * Not a property of the contract — a property of this file.
     *
     * Every invariant above passes trivially against a curve nobody ever traded,
     * so a handler that silently stopped producing trades would turn this whole
     * suite green while testing nothing. This asserts the run actually did
     * something, and prints the breakdown so the shape of it is visible rather
     * than merely non-zero.
     *
     * It lives in `afterInvariant` rather than in an `invariant_` function
     * because Foundry also evaluates every invariant against the *initial*
     * state, where no trade has happened yet by definition. `afterInvariant`
     * runs once per completed sequence, which is where a census belongs — and
     * its assertions still fail the suite.
     */
    function afterInvariant() public view {
        console.log("buys                  ", handler.buys());
        console.log("sells                 ", handler.sells());
        console.log("fee claims            ", handler.claims());
        console.log("fee claims refused    ", handler.deniedClaims());
        console.log("transfers             ", handler.transfers());
        console.log("pause toggles         ", handler.pauses());
        console.log("skipped (precondition)", handler.skipped());
        console.log("unexpected reverts    ", handler.reverted());
        console.log("traders in  (wei)     ", handler.tradersIn());
        console.log("traders out (wei)     ", handler.tradersOut());
        console.log("fees claimed (wei)    ", handler.feesClaimed());
        console.log("forced in (wei)       ", handler.forcedIn());
        console.log("final reserve         ", token.ethReserve());
        console.log("final obligation      ", token.getOutstandingSellObligation());

        assertGt(handler.buys(), 0, "no buy landed in the entire run");
        assertGt(handler.sells(), 0, "no sell landed in the entire run");
        assertEq(handler.reverted(), 0, "a call the handler expected to succeed reverted");
    }
}
