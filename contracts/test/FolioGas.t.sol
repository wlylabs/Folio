// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {FolioSale} from "../FolioSale.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";
import {FolioTestBase} from "./helpers/FolioTestBase.sol";

/**
 * Stage 4, part five: what the thing costs to use.
 *
 * `forge test --gas-report` already produces a per-function table across the
 * whole suite, and that table is the reference. What it cannot show is the
 * comparison this rewrite was undertaken for — the minimal-proxy launch path
 * against the full per-launch deploy it replaced — because the old contract is
 * not on the new path at all. That measurement is the point of this file.
 *
 * The numbers are measured with `gasleft()` around the call rather than read
 * from a snapshot file, so they are checked on every run and a regression fails
 * the build instead of showing up as a diff nobody reads. The bounds asserted
 * are ceilings with real headroom, not exact figures: this is a guard against a
 * later change quietly reintroducing a full deploy, not a golden-file test that
 * has to be updated every time the optimiser shifts.
 */
contract FolioGasTest is FolioTestBase {
    /**
     * The reason for the rewrite, measured against what it replaced.
     *
     * `FolioSale` is the stage-1 design: one complete ERC20 deployed per launch,
     * with all setup in its constructor. `createToken` is the new path, and it
     * does strictly *more* work than the old one — it clones, initialises,
     * writes a registry entry, bumps a counter and emits an event — and still
     * comes in far cheaper, because what it stops paying for is the code
     * deposit.
     *
     * The bare `new FolioToken()` figure is printed alongside so the split is
     * visible: most of what the clone still pays is storage writes that any
     * design has to pay, and what it removes is the ~1M gas of bytecode.
     */
    function test_Gas_CloneVersusTheLegacyFullDeploy() public {
        vm.prank(creator);
        uint256 before = gasleft();
        factory.createToken("Midnight Kettle", "KETL", SUPPLY);
        uint256 cloneGas = before - gasleft();

        before = gasleft();
        new FolioSale("Midnight Kettle", "KETL", SUPPLY, 0.0002 ether, creator);
        uint256 legacyGas = before - gasleft();

        before = gasleft();
        new FolioToken();
        uint256 bareImplementationGas = before - gasleft();

        console.log("=== Launch cost: minimal proxy vs full deploy ===");
        console.log("new: createToken (clone + full setup)  ", cloneGas);
        console.log("old: FolioSale full deploy             ", legacyGas);
        console.log("ref: bare FolioToken deploy, no setup  ", bareImplementationGas);
        console.log("saved per launch                       ", legacyGas - cloneGas);
        console.log(
            "saved, percent                         ", (legacyGas - cloneGas) * 100 / legacyGas
        );

        assertLt(cloneGas, legacyGas / 2, "the clone path should more than halve the old cost");
        assertLt(cloneGas, 400_000, "a full deploy appears to have crept back into createToken");
    }

    /// The one-off cost of standing the platform up. Paid once, ever.
    function test_Gas_DeployingThePlatform() public {
        uint256 before = gasleft();
        FolioFactory f = new FolioFactory(owner, _config());
        uint256 used = before - gasleft();

        console.log("=== One-off platform deployment ===");
        console.log("FolioFactory + implementation          ", used);
        assertTrue(f.implementation() != address(0));
    }

    /// Creating a launch, both overloads, warm and cold.
    function test_Gas_CreateToken() public {
        vm.startPrank(creator);

        uint256 before = gasleft();
        factory.createToken("Alpha", "ALP", SUPPLY);
        uint256 defaultTerms = before - gasleft();

        before = gasleft();
        factory.createToken("Beta", "BET", SUPPLY, 1 ether);
        uint256 chosenCap = before - gasleft();

        vm.stopPrank();

        console.log("=== createToken ===");
        console.log("on platform default terms              ", defaultTerms);
        console.log("with a creator-chosen cap              ", chosenCap);
    }

    /**
     * Buying, at each of the shapes the function can take.
     *
     * The first buy on a launch is the expensive one: it writes `ethReserve`,
     * `tokensSold` and `feesAccrued` from zero, and mints into an empty balance.
     * Everything after that is warm, which is the number that matters for a
     * launch's actual trading life.
     */
    function test_Gas_Buy() public {
        uint256 before = gasleft();
        _buy(alice, 1 ether, 0);
        uint256 firstBuy = before - gasleft();

        before = gasleft();
        _buy(alice, 1 ether, 0);
        uint256 sameBuyerAgain = before - gasleft();

        before = gasleft();
        _buy(bob, 0.5 ether, 0);
        uint256 newBuyer = before - gasleft();

        (uint256 quoted,,) = token.getBuyQuote(0.1 ether);
        before = gasleft();
        _buy(carol, 0.1 ether, quoted);
        uint256 withSlippageFloor = before - gasleft();

        // A buy that overshoots the ceiling: clamps, refunds, and graduates.
        before = gasleft();
        _buy(dave, 50 ether, 0);
        uint256 refundingBuy = before - gasleft();

        console.log("=== buy ===");
        console.log("first buy on a launch (all cold)       ", firstBuy);
        console.log("same buyer again (warm)                ", sameBuyerAgain);
        console.log("a new buyer (cold balance)             ", newBuyer);
        console.log("with a slippage floor set              ", withSlippageFloor);
        console.log("overshoots the ceiling: clamp + refund ", refundingBuy);

        assertLt(firstBuy, 250_000, "the first buy got expensive");
        assertLt(sameBuyerAgain, 120_000, "a warm buy got expensive");
    }

    /// Selling, in the shapes that matter.
    function test_Gas_Sell() public {
        _buy(alice, 2 ether, 0);
        _buy(bob, 1 ether, 0);
        uint256 aliceHeld = token.balanceOf(alice);

        uint256 before = gasleft();
        _sell(alice, aliceHeld / 4, 0);
        uint256 partialSale = before - gasleft();

        uint256 quoted = token.getSellPrice(aliceHeld / 4);
        before = gasleft();
        _sell(alice, aliceHeld / 4, quoted);
        uint256 withFloor = before - gasleft();

        before = gasleft();
        _sell(alice, token.balanceOf(alice), 0);
        uint256 fullExit = before - gasleft();

        // The last seller on the launch, which zeroes `tokensSold` and clears a
        // balance slot — the cheapest sell there is, thanks to the refunds.
        before = gasleft();
        _sell(bob, token.balanceOf(bob), 0);
        uint256 lastSellerOut = before - gasleft();

        console.log("=== sell ===");
        console.log("partial sale                           ", partialSale);
        console.log("with a slippage floor set              ", withFloor);
        console.log("full exit (clears the balance slot)    ", fullExit);
        console.log("the last holder out                    ", lastSellerOut);

        assertLt(partialSale, 150_000, "a sell got expensive");
    }

    /// Claiming fees, and the ERC20 surface.
    function test_Gas_ClaimFeesAndTransfers() public {
        _buy(alice, 1 ether, 0);

        uint256 before = gasleft();
        vm.prank(creator);
        token.claimFees();
        uint256 claim = before - gasleft();

        uint256 amount = token.balanceOf(alice) / 4;
        before = gasleft();
        vm.prank(alice);
        token.transfer(bob, amount);
        uint256 transferCold = before - gasleft();

        before = gasleft();
        vm.prank(alice);
        token.transfer(bob, amount);
        uint256 transferWarm = before - gasleft();

        console.log("=== fees and ERC20 ===");
        console.log("claimFees                              ", claim);
        console.log("transfer, recipient cold               ", transferCold);
        console.log("transfer, recipient warm               ", transferWarm);
    }

    /// What the read-only surface costs, since a frontend calls these on every
    /// keystroke and an indexer calls them on every block.
    function test_Gas_Views() public {
        _buy(alice, 1 ether, 0);

        uint256 before = gasleft();
        token.getBuyQuote(1 ether);
        uint256 buyQuote = before - gasleft();

        before = gasleft();
        token.getSellPrice(token.balanceOf(alice));
        uint256 sellQuote = before - gasleft();

        before = gasleft();
        token.currentPrice();
        uint256 price = before - gasleft();

        before = gasleft();
        token.getOutstandingSellObligation();
        uint256 obligation = before - gasleft();

        before = gasleft();
        token.reserveHealthBps();
        uint256 health = before - gasleft();

        console.log("=== views (per call, warm) ===");
        console.log("getBuyQuote                            ", buyQuote);
        console.log("getSellPrice                           ", sellQuote);
        console.log("currentPrice                           ", price);
        console.log("getOutstandingSellObligation           ", obligation);
        console.log("reserveHealthBps                       ", health);
    }

    /**
     * What the price-move signal from stage 3 costs on every trade.
     *
     * It is two extra `currentPrice()` reads per trade, and the question worth
     * answering is whether that was worth making opt-out per launch. Measured
     * against an otherwise identical launch with the signal disabled.
     */
    function test_Gas_CostOfThePriceMoveSignal() public {
        CurveConfig memory quiet = _config();
        quiet.priceMoveAlertBps = 0;
        vm.prank(owner);
        factory.setDefaultConfig(quiet);
        FolioToken silent = _create(SUPPLY);

        // Warm both launches so the comparison is like for like.
        _buyOn(silent, alice, 1 ether, 0);
        _buy(bob, 1 ether, 0);

        uint256 before = gasleft();
        _buyOn(silent, alice, 0.5 ether, 0);
        uint256 withoutSignal = before - gasleft();

        before = gasleft();
        _buy(bob, 0.5 ether, 0);
        uint256 withSignal = before - gasleft();

        console.log("=== LargePriceMove signal overhead ===");
        console.log("buy with the signal disabled           ", withoutSignal);
        console.log("buy with the signal enabled            ", withSignal);
        console.log("overhead per trade                     ", withSignal - withoutSignal);

        assertLt(withSignal - withoutSignal, 15_000, "the monitoring signal got expensive");
    }

    /**
     * What the proxy hop costs on every trade, forever.
     *
     * This is the other side of the clone trade-off: the launch is ~1.4M gas
     * cheaper to create, and every trade after that pays an extra `delegatecall`
     * plus the proxy's own dispatch. Measured against the implementation
     * contract called directly, initialised standalone so the two are doing
     * identical work.
     */
    function test_Gas_TheProxyHopOnEveryTrade() public {
        // Standing up the control takes a moment's explanation. Every normally
        // deployed `FolioToken` locks itself in its constructor via
        // `_disableInitializers`, so `new FolioToken()` can never be initialised
        // and cannot serve as an un-proxied instance. `vm.etch` copies runtime
        // code *without* storage, so the address below gets the same logic with
        // a clear initializer flag — which is exactly the un-proxied control
        // this measurement needs, and is not reachable on a real chain.
        address direct = makeAddr("unproxiedLogic");
        vm.etch(direct, factory.implementation().code);
        FolioToken logic = FolioToken(direct);
        logic.initialize(creator, "Direct", "DIR", SUPPLY, _config());

        // `logic.factory()` is this test contract, which answers `paused()` below.
        assertEq(logic.factory(), address(this));

        // Warm both sides so the comparison is like for like.
        _buy(alice, 1 ether, 0);
        vm.prank(alice);
        logic.buy{value: 1 ether}(0);

        uint256 before = gasleft();
        vm.prank(alice);
        logic.buy{value: 0.5 ether}(0);
        uint256 noProxy = before - gasleft();

        before = gasleft();
        _buy(alice, 0.5 ether, 0);
        uint256 throughProxy = before - gasleft();

        console.log("=== EIP-1167 proxy overhead ===");
        console.log("buy called on the logic directly       ", noProxy);
        console.log("buy through the clone                  ", throughProxy);
        console.log("overhead per trade                     ", throughProxy - noProxy);

        assertLt(throughProxy - noProxy, 10_000, "the proxy hop got expensive");
    }

    /// Stands in for the factory for {test_Gas_TheProxyHopOnEveryTrade}, whose
    /// standalone token records this contract as its factory.
    function paused() external pure returns (bool) {
        return false;
    }
}
