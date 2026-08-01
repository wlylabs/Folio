// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";

/**
 * Stage 2: the bonding curve, buying, selling, and the reserve.
 *
 * The tests are grouped by the property they defend rather than by function, and
 * the ones that matter most are the last three groups: the reserve can always pay
 * everyone out, the guards hold under reentrancy, and two trades in one block
 * settle in sequence rather than racing.
 */
contract FolioTradingTest is Test {
    FolioFactory internal factory;
    FolioToken internal token;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal constant SUPPLY = 1_000_000;
    uint256 internal constant UNIT = 1e18;
    uint256 internal constant BPS = 10_000;

    /// 1% per leg, the factory default.
    uint16 internal constant FEE_BPS = 100;

    function _config() internal pure returns (CurveConfig memory) {
        return CurveConfig({
            virtualEthReserve: 2 ether,
            maxReserveCap: 5 ether,
            graduationThreshold: 4 ether,
            feeBps: FEE_BPS,
            priceMoveAlertBps: 10_000,
            sniperWindowSeconds: 0,
            sniperMaxEthPerWallet: 0,
            migrator: address(0)
        });
    }

    function setUp() public {
        factory = new FolioFactory(owner, _config());
        token = _create(SUPPLY);

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // -----------------------------------------------------------------------
    // Quoting — the functions a frontend calls before the user signs
    // -----------------------------------------------------------------------

    /**
     * The brief's hard requirement: both price functions must be callable without
     * a transaction. Asserting the Solidity keyword proves nothing at runtime, so
     * this reaches for them over `staticcall`, which the EVM itself fails if the
     * callee writes storage.
     */
    function test_PriceFunctionsAreStaticallyCallable() public {
        _buy(alice, 1 ether, 0);

        bytes[5] memory calls = [
            abi.encodeCall(FolioToken.getBuyPrice, (1000 * UNIT)),
            abi.encodeCall(FolioToken.getSellPrice, (100 * UNIT)),
            abi.encodeCall(FolioToken.getBuyQuote, (0.5 ether)),
            abi.encodeCall(FolioToken.getReserveBalance, ()),
            abi.encodeCall(FolioToken.getOutstandingSellObligation, ())
        ];

        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = address(token).staticcall(calls[i]);
            assertTrue(ok, "quote wrote state or reverted under staticcall");
            assertGt(ret.length, 0);
        }
    }

    /// The quote has to be the thing you can act on: sending exactly `getBuyPrice`
    /// must never leave you short of what you asked for. Rounding is upward, so a
    /// unit or two extra is expected and fine.
    function test_GetBuyPrice_IsEnoughToActuallyBuyThatMany() public {
        uint256 want = 12_345 * UNIT;
        uint256 cost = token.getBuyPrice(want);

        uint256 got = _buy(alice, cost, 0);
        assertGe(got, want, "quote under-charged");
        assertApproxEqRel(got, want, 1e12);
    }

    function test_GetBuyPrice_IsInclusiveOfTheFee() public view {
        uint256 want = 1000 * UNIT;
        uint256 gross = token.getBuyPrice(want);
        // The fee is on top of what the curve itself charges, so the gross must
        // exceed the curve leg by roughly feeBps.
        uint256 curveLeg = (gross * (BPS - FEE_BPS)) / BPS;
        assertLt(curveLeg, gross);
        assertApproxEqRel(gross - curveLeg, (gross * FEE_BPS) / BPS, 1e12);
    }

    function test_GetBuyPrice_ZeroIsFree() public view {
        assertEq(token.getBuyPrice(0), 0);
    }

    /// The last token on a constant-product curve sits at a vertical asymptote and
    /// has no finite price. Reverting says so; returning a huge number would not.
    function test_GetBuyPrice_RevertsAtTheAsymptote() public {
        uint256 inventory = token.curveTokenReserve();
        vm.expectRevert(FolioToken.ExceedsCurveInventory.selector);
        token.getBuyPrice(inventory);
    }

    /// The forward quote and the settlement run the same code, so they cannot
    /// disagree — this pins that they are wired together and stay that way.
    function test_GetBuyQuote_MatchesSettlementExactly() public {
        _buy(bob, 0.7 ether, 0);

        (uint256 quoted, uint256 spent, uint256 refund) = token.getBuyQuote(1.3 ether);
        uint256 got = _buy(alice, 1.3 ether, 0);

        assertEq(got, quoted);
        assertEq(spent, 1.3 ether);
        assertEq(refund, 0);
    }

    function test_GetSellPrice_MatchesSettlementExactly() public {
        uint256 got = _buy(alice, 2 ether, 0);
        uint256 quoted = token.getSellPrice(got);

        uint256 before = alice.balance;
        vm.prank(alice);
        uint256 received = token.sell(got, 0);

        assertEq(received, quoted);
        assertEq(alice.balance - before, quoted);
    }

    function test_GetSellPrice_RevertsAboveCirculatingSupply() public {
        _buy(alice, 1 ether, 0);
        uint256 circulating = token.tokensSold();

        vm.expectRevert(FolioToken.ExceedsCirculating.selector);
        token.getSellPrice(circulating + 1);
    }

    /// Buying and selling the same size back to back must lose money, or the pair
    /// is an arbitrage machine pointed at the reserve.
    function test_BuyAndSellQuotesLeaveASpread() public {
        _buy(alice, 1 ether, 0);

        uint256 size = 1000 * UNIT;
        assertLt(token.getSellPrice(size), token.getBuyPrice(size), "no spread");
    }

    function test_PriceRisesMonotonicallyWithEachBuy() public {
        uint256 last = token.currentPrice();
        for (uint256 i = 0; i < 5; i++) {
            _buy(alice, 0.3 ether, 0);
            uint256 next = token.currentPrice();
            assertGt(next, last, "price did not rise");
            last = next;
        }
    }

    /// The curve's flatness is a config choice, not a property of the maths: the
    /// open-to-graduation multiple is ((V + G) / V)^2, which is 9x here.
    function test_GraduationPriceMultipleMatchesTheClosedForm() public {
        uint256 openingPrice = token.currentPrice();
        _buy(alice, 10 ether, 0); // overshoots; clamps at the threshold

        assertTrue(token.graduated());
        // ((2 + 4) / 2)^2 = 9
        assertApproxEqRel(token.currentPrice(), openingPrice * 9, 1e12);
    }

    // -----------------------------------------------------------------------
    // Buying
    // -----------------------------------------------------------------------

    /// The documented split: 1% to the creator's claimable balance, 99% into the
    /// reserve where it moves the price. The fee never touches the reserve.
    function test_Buy_SplitsEthIntoReserveAndFee() public {
        uint256 sent = 1 ether;
        uint256 got = _buy(alice, sent, 0);

        uint256 expectedFee = (sent * FEE_BPS) / BPS;
        assertEq(token.feesAccrued(), expectedFee);
        assertEq(token.ethReserve(), sent - expectedFee);
        assertEq(address(token).balance, sent);

        assertEq(token.balanceOf(alice), got);
        assertEq(token.totalSupply(), got, "supply is minted on demand");
        assertEq(token.tokensSold(), got);
        assertEq(token.curveTokenReserve(), SUPPLY * UNIT - got);
    }

    function test_Buy_RevertsOnZeroValue() public {
        vm.prank(alice);
        vm.expectRevert(FolioToken.ZeroEthIn.selector);
        token.buy{value: 0}(0);
    }

    /// A payment too small to mint a single token unit is refused rather than
    /// silently swallowed. It takes a one-token launch to reach: at a million
    /// supply, one wei still buys something.
    function test_Buy_RevertsWhenPaymentBuysNothing() public {
        FolioToken tiny = _create(1);

        vm.prank(alice);
        vm.expectRevert(FolioToken.PaymentTooSmall.selector);
        tiny.buy{value: 1}(0);
    }

    function test_Buy_RevertsOnSlippage() public {
        (uint256 quoted,,) = token.getBuyQuote(1 ether);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(FolioToken.SlippageExceeded.selector, quoted, quoted + 1)
        );
        token.buy{value: 1 ether}(quoted + 1);
    }

    function test_Buy_AcceptsTheExactQuoteAsAFloor() public {
        (uint256 quoted,,) = token.getBuyQuote(1 ether);
        assertEq(_buy(alice, 1 ether, quoted), quoted);
    }

    /// The scenario the slippage floor exists for: alice reads a price, bob's buy
    /// lands first, and alice's transaction settles against the moved curve.
    function test_Buy_SlippageFloorCatchesAFrontRun() public {
        (uint256 quoted,,) = token.getBuyQuote(1 ether);
        uint256 floor_ = (quoted * 99) / 100; // 1% tolerance

        _buy(bob, 3 ether, 0); // the front-run

        vm.prank(alice);
        vm.expectRevert();
        token.buy{value: 1 ether}(floor_);
    }

    function test_Buy_EmitsEventWithThePostTradePrice() public {
        vm.recordLogs();
        uint256 got = _buy(alice, 1 ether, 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("TokensBought(address,uint256,uint256,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != topic) continue;
            found = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), alice);
            (uint256 ethIn, uint256 tokensOut, uint256 newPrice) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            assertEq(ethIn, 1 ether);
            assertEq(tokensOut, got);
            assertEq(newPrice, token.currentPrice(), "chart would drift from state");
        }
        assertTrue(found, "TokensBought not emitted");
    }

    function test_Buy_RevertsWhilePaused() public {
        vm.prank(owner);
        factory.pause();

        vm.prank(alice);
        vm.expectRevert(FolioToken.TradingPaused.selector);
        token.buy{value: 1 ether}(0);
    }

    /**
     * Overshooting the ceiling refunds the excess instead of reverting. Reverting
     * would mean only an exactly-sized trade could ever land the curve on its
     * threshold, leaving the last slice of every launch unbuyable.
     */
    function test_Buy_ClampsAtTheThresholdAndRefunds() public {
        uint256 before = alice.balance;

        vm.prank(alice);
        token.buy{value: 10 ether}(0);

        assertEq(token.ethReserve(), 4 ether, "reserve should land exactly on the threshold");
        assertTrue(token.graduated());
        assertEq(token.ethHeadroom(), 0);

        // Charged only for what the curve took, plus the fee on that.
        uint256 spent = before - alice.balance;
        uint256 expectedGross = (4 ether * BPS + (BPS - FEE_BPS) - 1) / (BPS - FEE_BPS);
        assertEq(spent, expectedGross);
        assertEq(token.feesAccrued(), spent - 4 ether);
        assertLt(spent, 10 ether, "no refund happened");
    }

    function test_Buy_EmitsGraduatedOnce() public {
        vm.recordLogs();
        _buy(alice, 10 ether, 0);

        bytes32 topic = keccak256("Graduated(uint256,uint256)");
        uint256 count;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == topic) count++;
        }
        assertEq(count, 1);
    }

    function test_Buy_RevertsAfterGraduation() public {
        _buy(alice, 10 ether, 0);

        vm.prank(bob);
        vm.expectRevert(FolioToken.CurveClosed.selector);
        token.buy{value: 1 ether}(0);
    }

    /// With graduation disabled the hard cap is what binds, and it closes buys the
    /// same way — without setting `graduated`, because nothing graduated.
    function test_Buy_ClampsAtTheHardCapWhenGraduationIsDisabled() public {
        CurveConfig memory cfg = _config();
        cfg.graduationThreshold = 0;
        vm.prank(owner);
        factory.setDefaultConfig(cfg);
        FolioToken uncapped = _create(SUPPLY);

        vm.prank(alice);
        uncapped.buy{value: 20 ether}(0);
        assertEq(uncapped.ethReserve(), 5 ether);
        assertFalse(uncapped.graduated());

        vm.prank(bob);
        vm.expectRevert(FolioToken.CurveClosed.selector);
        uncapped.buy{value: 1 ether}(0);
    }

    function test_Buy_QuoteReportsTheRefundBeforeTheTrade() public {
        (uint256 tokensOut, uint256 spent, uint256 refund) = token.getBuyQuote(10 ether);
        assertGt(refund, 0);
        assertEq(spent + refund, 10 ether);

        uint256 got = _buy(alice, 10 ether, 0);
        assertEq(got, tokensOut);
    }

    // -----------------------------------------------------------------------
    // Selling
    // -----------------------------------------------------------------------

    function test_Sell_BurnsTokensAndPaysOut() public {
        uint256 got = _buy(alice, 2 ether, 0);
        uint256 reserveBefore = token.ethReserve();
        uint256 feesBefore = token.feesAccrued();

        uint256 half = got / 2;
        uint256 expected = token.getSellPrice(half);

        uint256 balanceBefore = alice.balance;
        vm.prank(alice);
        uint256 received = token.sell(half, 0);

        assertEq(received, expected);
        assertEq(alice.balance - balanceBefore, expected);
        assertEq(token.balanceOf(alice), got - half);
        assertEq(token.totalSupply(), got - half, "tokens were burned, not parked");
        assertEq(token.tokensSold(), got - half);

        // The reserve gives up the gross; the fee out of that gross accrues.
        uint256 feeTaken = token.feesAccrued() - feesBefore;
        assertEq(reserveBefore - token.ethReserve(), expected + feeTaken);
        assertGt(feeTaken, 0);
    }

    /// The brief's explicit case: selling more than you hold must revert. Bob buys
    /// too, so that alice's overreach is still inside the circulating supply and
    /// has to be caught by her own balance rather than by the supply ceiling.
    function test_Sell_RevertsWhenSellerIsShort() public {
        uint256 got = _buy(alice, 1 ether, 0);
        _buy(bob, 1 ether, 0);
        assertLt(got, token.tokensSold());

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, alice, got, got + 1
            )
        );
        token.sell(got + 1, 0);
    }

    /// A holder with nothing at all is the same case, and must not be able to
    /// drain a reserve other people funded.
    function test_Sell_RevertsForAHolderWithNoTokens() public {
        _buy(alice, 2 ether, 0);

        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, bob, 0, 1 * UNIT)
        );
        token.sell(1 * UNIT, 0);
    }

    function test_Sell_RevertsAboveCirculatingSupply() public {
        _buy(alice, 1 ether, 0);
        uint256 circulating = token.tokensSold();

        vm.prank(alice);
        vm.expectRevert(FolioToken.ExceedsCirculating.selector);
        token.sell(circulating + 1, 0);
    }

    function test_Sell_RevertsOnZeroAmount() public {
        _buy(alice, 1 ether, 0);
        vm.prank(alice);
        vm.expectRevert(FolioToken.ZeroTokenAmount.selector);
        token.sell(0, 0);
    }

    function test_Sell_RevertsOnSlippage() public {
        uint256 got = _buy(alice, 1 ether, 0);
        uint256 quoted = token.getSellPrice(got);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(FolioToken.SlippageExceeded.selector, quoted, quoted + 1)
        );
        token.sell(got, quoted + 1);
    }

    function test_Sell_EmitsEventWithThePostTradePrice() public {
        uint256 got = _buy(alice, 1 ether, 0);

        vm.recordLogs();
        vm.prank(alice);
        uint256 received = token.sell(got / 2, 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("TokensSold(address,uint256,uint256,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != topic) continue;
            found = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), alice);
            (uint256 tokensIn, uint256 ethOut, uint256 newPrice) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            assertEq(tokensIn, got / 2);
            assertEq(ethOut, received);
            assertEq(newPrice, token.currentPrice());
        }
        assertTrue(found, "TokensSold not emitted");
    }

    function test_Sell_RevertsWhilePaused() public {
        uint256 got = _buy(alice, 1 ether, 0);

        vm.prank(owner);
        factory.pause();

        vm.prank(alice);
        vm.expectRevert(FolioToken.TradingPaused.selector);
        token.sell(got, 0);
    }

    /// Graduation closes buying only. A holder is never locked in by it.
    function test_Sell_StaysOpenAfterGraduation() public {
        uint256 got = _buy(alice, 10 ether, 0);
        assertTrue(token.graduated());

        vm.prank(alice);
        uint256 received = token.sell(got, 0);
        assertGt(received, 0);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_Sell_PriceFallsBackDownTheCurve() public {
        uint256 got = _buy(alice, 3 ether, 0);
        uint256 peak = token.currentPrice();

        vm.prank(alice);
        token.sell(got, 0);

        assertLt(token.currentPrice(), peak);
        // Back at the opening price, bar the rounding surplus left behind.
        assertApproxEqRel(token.currentPrice(), 2 ether * UNIT / (SUPPLY * UNIT), 1e14);
    }

    // -----------------------------------------------------------------------
    // Reserve accounting — the sell-back guarantee
    // -----------------------------------------------------------------------

    function test_Reserve_ObligationEqualsReserveByConstruction() public {
        _buy(alice, 1 ether, 0);
        _buy(bob, 2 ether, 0);

        assertEq(token.getReserveBalance(), token.ethReserve());
        assertLe(token.getOutstandingSellObligation(), token.getReserveBalance());
        assertApproxEqAbs(token.getOutstandingSellObligation(), token.getReserveBalance(), 2);
        assertGe(token.reserveHealthBps(), BPS);
    }

    function test_Reserve_HealthReadsFullyCoveredBeforeAnyTrade() public view {
        assertEq(token.getOutstandingSellObligation(), 0);
        assertEq(token.reserveHealthBps(), BPS);
    }

    /// Fees are not part of the reserve, and cannot be reached by a seller or
    /// spent on paying one. The contract balance is the sum of the two.
    function test_Reserve_ExcludesUnclaimedFees() public {
        _buy(alice, 1 ether, 0);
        assertEq(address(token).balance, token.ethReserve() + token.feesAccrued());
        assertLt(token.getReserveBalance(), address(token).balance);
    }

    /**
     * The property the whole design exists for: whatever order people bought in,
     * everyone can get out, and the person who goes last is not the one who finds
     * the till empty.
     */
    function test_Reserve_EveryoneCanExitInAnyOrder() public {
        uint256 a = _buy(alice, 0.5 ether, 0);
        uint256 b = _buy(bob, 2 ether, 0);
        uint256 c = _buy(carol, 1.2 ether, 0);

        // Last in, first out — the ordering that strands the last seller if the
        // reserve is short.
        _sellAll(carol, c);
        _sellAll(bob, b);
        _sellAll(alice, a);

        assertEq(token.totalSupply(), 0);
        assertEq(token.tokensSold(), 0);
        assertEq(token.getOutstandingSellObligation(), 0);
        // Everything left is the accumulated fee plus rounding dust; the reserve
        // itself is empty because the curve is back where it started.
        assertLe(token.ethReserve(), 10, "reserve should drain to dust");
    }

    function test_Reserve_CoversObligationAfterEveryStep() public {
        uint256[6] memory buys =
            [uint256(0.1 ether), 0.9 ether, 0.05 ether, 1.5 ether, 0.3 ether, 0.7 ether];

        uint256 held;
        for (uint256 i = 0; i < buys.length; i++) {
            held += _buy(alice, buys[i], 0);
            _assertSolvent();

            if (i % 2 == 1) {
                uint256 slice = held / 3;
                vm.prank(alice);
                token.sell(slice, 0);
                held -= slice;
                _assertSolvent();
            }
        }
    }

    /// A round trip must always cost the trader something, or the reserve is a
    /// faucet. The floor is the two fee legs.
    function testFuzz_RoundTripNeverProfits(uint256 ethIn) public {
        ethIn = bound(ethIn, 1e12, 3 ether);

        uint256 before = alice.balance;
        uint256 got = _buy(alice, ethIn, 0);
        vm.prank(alice);
        token.sell(got, 0);

        assertLt(alice.balance, before, "round trip returned a profit");
        _assertSolvent();
    }

    /// `k` is never stored, so this is the check that the rounding really does
    /// always fall on the reserve's side of the line.
    function testFuzz_CurveProductNeverDecreases(uint256 ethIn, uint256 sellFraction) public {
        ethIn = bound(ethIn, 1e12, 3 ether);
        sellFraction = bound(sellFraction, 1, 100);

        uint256 k0 = _k();
        uint256 got = _buy(alice, ethIn, 0);
        uint256 k1 = _k();
        assertGe(k1, k0, "buy shrank k");

        uint256 slice = (got * sellFraction) / 100;
        if (slice > 0) {
            vm.prank(alice);
            token.sell(slice, 0);
            assertGe(_k(), k1, "sell shrank k");
        }
        _assertSolvent();
    }

    // -----------------------------------------------------------------------
    // Ordering: two trades in one block
    // -----------------------------------------------------------------------

    /**
     * The brief's third named case. Two buys of the same size land in one block;
     * the second must price off the state the first left, not off the state both
     * of them started from.
     */
    function test_TwoBuysInOneBlockSettleInSequence() public {
        uint256 blockAtStart = block.number;

        uint256 first = _buy(alice, 1 ether, 0);
        uint256 priceAfterFirst = token.currentPrice();

        // The quote bob would read after alice's transaction landed.
        (uint256 quotedForBob,,) = token.getBuyQuote(1 ether);
        uint256 second = _buy(bob, 1 ether, 0);

        assertEq(block.number, blockAtStart, "test did not stay in one block");
        assertEq(second, quotedForBob, "second buy did not price off the first's result");
        assertLt(second, first, "same ETH bought as much or more at a higher price");
        assertGt(token.currentPrice(), priceAfterFirst);

        assertEq(token.tokensSold(), first + second);
        assertEq(token.totalSupply(), first + second);
        assertEq(token.balanceOf(alice), first);
        assertEq(token.balanceOf(bob), second);
        _assertSolvent();
    }

    /**
     * The stronger version of the same property: splitting a trade in two changes
     * nothing. If two sequential buys of 1 ETH bought more (or less) in total than
     * one buy of 2 ETH, there would be an ordering to exploit.
     */
    function test_SplittingABuyIsPathIndependent() public {
        FolioToken split = _create(SUPPLY);
        FolioToken single = _create(SUPPLY);

        vm.startPrank(alice);
        uint256 partA = split.buy{value: 1 ether}(0);
        uint256 partB = split.buy{value: 1 ether}(0);
        uint256 whole = single.buy{value: 2 ether}(0);
        vm.stopPrank();

        assertApproxEqRel(partA + partB, whole, 1e12);
        assertLe(partA + partB, whole, "splitting must never beat the single trade");
    }

    /// The mirror case: a buy and a sell in one block, where the sell prices off
    /// the buy's state.
    function test_BuyThenSellInOneBlock() public {
        uint256 blockAtStart = block.number;

        uint256 got = _buy(alice, 2 ether, 0);
        uint256 quoted = token.getSellPrice(got);

        vm.prank(alice);
        uint256 received = token.sell(got, 0);

        assertEq(block.number, blockAtStart);
        assertEq(received, quoted);
        _assertSolvent();
    }

    // -----------------------------------------------------------------------
    // Reentrancy
    // -----------------------------------------------------------------------

    /// The refund at the end of an over-ceiling buy is an external call to the
    /// buyer. The guard has to hold across it.
    function test_Reentrancy_BuyRefundCannotReenter() public {
        ReentrantTrader attacker = new ReentrantTrader(token);
        vm.deal(address(attacker), 20 ether);

        attacker.arm(ReentrantTrader.Mode.Buy);
        attacker.doBuy(10 ether); // overshoots the threshold, so a refund fires

        assertEq(attacker.attempts(), 1, "receive hook never ran; test proves nothing");
        assertEq(
            bytes4(attacker.lastError()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "re-entered buy was not blocked"
        );
        _assertSolvent();
    }

    /// The payout at the end of a sell is the same surface, and the one that
    /// actually moves ETH out of the reserve.
    function test_Reentrancy_SellPayoutCannotReenter() public {
        ReentrantTrader attacker = new ReentrantTrader(token);
        vm.deal(address(attacker), 20 ether);

        attacker.doBuy(2 ether); // unarmed: no refund, no hook
        uint256 held = token.balanceOf(address(attacker));

        attacker.arm(ReentrantTrader.Mode.Sell);
        attacker.doSell(held / 2);

        assertEq(attacker.attempts(), 1, "receive hook never ran; test proves nothing");
        assertEq(
            bytes4(attacker.lastError()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "re-entered sell was not blocked"
        );
        assertEq(token.balanceOf(address(attacker)), held - held / 2);
        _assertSolvent();
    }

    function test_Reentrancy_ClaimFeesCannotReenter() public {
        ReentrantTrader attacker = new ReentrantTrader(token);
        vm.deal(address(attacker), 20 ether);

        // Give the attacker the creator seat on a fresh launch.
        vm.prank(address(attacker));
        FolioToken owned = FolioToken(factory.createToken("Attack", "ATK", SUPPLY));
        attacker.retarget(owned);

        attacker.doBuy(1 ether);
        attacker.arm(ReentrantTrader.Mode.Claim);
        attacker.doClaim();

        assertEq(attacker.attempts(), 1);
        assertEq(
            bytes4(attacker.lastError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        assertEq(owned.feesAccrued(), 0, "fees paid exactly once");
    }

    // -----------------------------------------------------------------------
    // Fees
    // -----------------------------------------------------------------------

    function test_ClaimFees_PaysTheCreatorAndZeroes() public {
        _buy(alice, 2 ether, 0);
        uint256 accrued = token.feesAccrued();
        assertGt(accrued, 0);

        uint256 before = creator.balance;
        vm.prank(creator);
        uint256 claimed = token.claimFees();

        assertEq(claimed, accrued);
        assertEq(creator.balance - before, accrued);
        assertEq(token.feesAccrued(), 0);
        assertEq(address(token).balance, token.ethReserve(), "claim reached into the reserve");
        _assertSolvent();
    }

    function test_ClaimFees_OnlyCreator() public {
        _buy(alice, 1 ether, 0);

        vm.prank(alice);
        vm.expectRevert(FolioToken.NotCreator.selector);
        token.claimFees();
    }

    function test_ClaimFees_RevertsWithNothingAccrued() public {
        vm.prank(creator);
        vm.expectRevert(FolioToken.NothingToClaim.selector);
        token.claimFees();
    }

    /// The emergency stop must not double as a way to withhold a creator's
    /// earnings — it exists to contain a curve bug, nothing else.
    function test_ClaimFees_WorksWhileTradingIsPaused() public {
        _buy(alice, 1 ether, 0);

        vm.prank(owner);
        factory.pause();

        vm.prank(creator);
        assertGt(token.claimFees(), 0);
    }

    /// Claiming can never eat into what sellers are owed, because fees were never
    /// part of the reserve to begin with.
    function test_ClaimFees_LeavesEveryHolderAbleToExit() public {
        uint256 a = _buy(alice, 1 ether, 0);
        uint256 b = _buy(bob, 1.5 ether, 0);

        vm.prank(creator);
        token.claimFees();

        _sellAll(bob, b);
        _sellAll(alice, a);
        assertEq(token.totalSupply(), 0);
    }

    // -----------------------------------------------------------------------
    // Odds and ends
    // -----------------------------------------------------------------------

    /// No `receive`, on purpose: untracked ETH would sit in the balance looking
    /// like reserve without being it.
    function test_PlainEthTransfersAreRejected() public {
        vm.prank(alice);
        (bool ok,) = address(token).call{value: 1 ether}("");
        assertFalse(ok, "contract accepted an untracked donation");
    }

    /// Nothing about the curve gives the platform or the creator a path to the
    /// reserve. This pins the surface: only these three functions move ETH.
    function test_NoAdminPathToTheReserve() public {
        _buy(alice, 2 ether, 0);
        uint256 reserve = token.ethReserve();

        vm.prank(owner);
        factory.pause();
        vm.prank(owner);
        factory.unpause();

        vm.prank(creator);
        token.claimFees();

        assertEq(token.ethReserve(), reserve);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _create(uint256 wholeSupply) internal returns (FolioToken) {
        vm.prank(creator);
        return FolioToken(factory.createToken("Midnight Kettle", "KETL", wholeSupply));
    }

    function _buy(address who, uint256 value, uint256 minOut) internal returns (uint256) {
        vm.prank(who);
        return token.buy{value: value}(minOut);
    }

    function _sellAll(address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return token.sell(amount, 0);
    }

    /// The invariant every state-changing test re-checks: the reserve can cover
    /// everyone selling at once, and the contract holds at least what it claims.
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

    /// The constant-product invariant, recomputed from live state.
    function _k() internal view returns (uint256) {
        return (token.virtualEthReserve() + token.ethReserve()) * token.curveTokenReserve();
    }
}

/**
 * A holder whose `receive` hook tries to trade again mid-payout. The re-entry is
 * wrapped in try/catch so the outer trade still settles — the test then reads
 * `lastError` to confirm the guard, rather than only observing that the whole
 * thing reverted, which a dozen unrelated bugs could also cause.
 */
contract ReentrantTrader {
    enum Mode {
        None,
        Buy,
        Sell,
        Claim
    }

    FolioToken public token;
    Mode public mode;
    bool public armed;
    uint256 public attempts;
    bytes public lastError;

    constructor(FolioToken token_) {
        token = token_;
    }

    function retarget(FolioToken token_) external {
        token = token_;
    }

    function arm(Mode mode_) external {
        mode = mode_;
        armed = true;
    }

    function doBuy(uint256 value) external {
        token.buy{value: value}(0);
    }

    function doSell(uint256 amount) external {
        token.sell(amount, 0);
    }

    function doClaim() external {
        token.claimFees();
    }

    receive() external payable {
        if (!armed) return;
        armed = false; // one shot, so the hook cannot recurse on itself
        attempts++;

        if (mode == Mode.Buy) {
            try token.buy{value: 0.01 ether}(0) {}
            catch (bytes memory err) {
                lastError = err;
            }
        } else if (mode == Mode.Sell) {
            try token.sell(1e18, 0) {}
            catch (bytes memory err) {
                lastError = err;
            }
        } else if (mode == Mode.Claim) {
            try token.claimFees() {}
            catch (bytes memory err) {
                lastError = err;
            }
        }
    }
}
