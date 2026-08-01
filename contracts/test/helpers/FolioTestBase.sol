// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FolioFactory} from "../../src/FolioFactory.sol";
import {FolioToken} from "../../src/FolioToken.sol";
import {CurveConfig} from "../../src/types/CurveConfig.sol";

/**
 * Shared ground for the stage-4 suites.
 *
 * Two things live here that are worth being explicit about.
 *
 * The first is the curve maths, re-implemented in {_predictBuy} and
 * {_predictSell} from the specification in `CurveConfig` rather than copied out
 * of `FolioToken`. A test that checks the contract against its own quote
 * functions only proves the contract agrees with itself; these are written from
 * the description of what the curve is supposed to do, using plain arithmetic
 * instead of `Math.mulDiv`, so when they agree with settlement that means
 * something. Every input this suite feeds them stays far below the point where
 * the missing 512-bit intermediate would matter — see the note on each.
 *
 * The second is {_assertSolvent}, the property the whole stage exists to
 * defend: the reserve can pay everyone out, the contract holds at least what it
 * has promised, and the ERC20's idea of supply matches the curve's. It is
 * re-checked after every state change in every suite below, so a violation is
 * attributed to the trade that caused it rather than discovered at the end.
 */
abstract contract FolioTestBase is Test {
    FolioFactory internal factory;
    FolioToken internal token;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal eve = makeAddr("eve");

    uint256 internal constant SUPPLY = 1_000_000;
    uint256 internal constant UNIT = 1e18;
    uint256 internal constant BPS = 10_000;
    uint16 internal constant FEE_BPS = 100;

    /// Slot 7 holds `ethReserve`. Confirmed against `forge inspect FolioToken
    /// storage-layout`, and used by exactly one test — the one that has to
    /// manufacture a state the curve maths cannot reach on its own.
    uint256 internal constant SLOT_ETH_RESERVE = 7;

    function _config() internal pure virtual returns (CurveConfig memory) {
        return CurveConfig({
            virtualEthReserve: 2 ether,
            maxReserveCap: 5 ether,
            graduationThreshold: 4 ether,
            feeBps: FEE_BPS,
            priceMoveAlertBps: 10_000,
            // Off by default across the shared suites, so every expectation below
            // is about the curve alone. `FolioAntiSniper.t.sol` overrides it.
            sniperWindowSeconds: 0,
            sniperMaxEthPerWallet: 0,
            migrator: address(0)
        });
    }

    function setUp() public virtual {
        factory = new FolioFactory(owner, _config());
        token = _create(SUPPLY);

        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
        vm.deal(dave, 1_000 ether);
        vm.deal(eve, 1_000 ether);
    }

    // -----------------------------------------------------------------------
    // Launching
    // -----------------------------------------------------------------------

    function _create(uint256 wholeSupply) internal returns (FolioToken) {
        return _createAs(creator, "Midnight Kettle", "KETL", wholeSupply);
    }

    function _createAs(address who, string memory name_, string memory symbol_, uint256 wholeSupply)
        internal
        returns (FolioToken)
    {
        vm.prank(who);
        return FolioToken(factory.createToken(name_, symbol_, wholeSupply));
    }

    function _createCapped(uint256 wholeSupply, uint256 cap) internal returns (FolioToken) {
        vm.prank(creator);
        return FolioToken(factory.createToken("Midnight Kettle", "KETL", wholeSupply, cap));
    }

    /// A launch whose *cap* is the binding ceiling, with graduation switched off.
    function _createWithoutGraduation(uint256 cap) internal returns (FolioToken) {
        CurveConfig memory cfg = _config();
        cfg.graduationThreshold = 0;
        vm.prank(owner);
        factory.setDefaultConfig(cfg);
        return _createCapped(SUPPLY, cap);
    }

    // -----------------------------------------------------------------------
    // Trading
    // -----------------------------------------------------------------------

    function _buy(address who, uint256 value, uint256 minOut) internal returns (uint256) {
        vm.prank(who);
        return token.buy{value: value}(minOut);
    }

    function _buyOn(FolioToken t, address who, uint256 value, uint256 minOut)
        internal
        returns (uint256)
    {
        vm.prank(who);
        return t.buy{value: value}(minOut);
    }

    function _sell(address who, uint256 amount, uint256 minOut) internal returns (uint256) {
        vm.prank(who);
        return token.sell(amount, minOut);
    }

    function _sellOn(FolioToken t, address who, uint256 amount, uint256 minOut)
        internal
        returns (uint256)
    {
        vm.prank(who);
        return t.sell(amount, minOut);
    }

    // -----------------------------------------------------------------------
    // The curve, written out from the specification
    // -----------------------------------------------------------------------

    /**
     * What a buy of `ethIn` should produce, derived from `x * y = k` rather than
     * from `FolioToken`'s own code.
     *
     * The fee comes off the top and never touches the curve, so only `netEth`
     * moves the price. Tokens out is the drop in the token side of the curve:
     * `y - k / (x + netEth)`, which rearranges to the expression below.
     *
     * Plain `*` and `/`, deliberately, so this is not a transcription of the
     * contract's `mulDiv` calls. `inventory` tops out at 1e33 and `netEth` at
     * about 1e24 across this suite, so the widest intermediate is ~1e57 against a
     * uint256 ceiling of ~1.16e77.
     */
    function _predictBuy(FolioToken t, uint256 ethIn)
        internal
        view
        returns (uint256 tokensOut, uint256 netEth, uint256 fee)
    {
        fee = (ethIn * t.feeBps()) / BPS;
        netEth = ethIn - fee;
        uint256 x = t.virtualEthReserve() + t.ethReserve();
        uint256 y = t.curveSupply() - t.tokensSold();
        tokensOut = (y * netEth) / (x + netEth);
    }

    /**
     * What a sell of `tokenAmount` should pay, derived the same way in reverse:
     * the ETH side falls by `x - k / (y + tokenAmount)`, and the fee is withheld
     * from that gross figure afterwards.
     */
    function _predictSell(FolioToken t, uint256 tokenAmount)
        internal
        view
        returns (uint256 ethOut, uint256 grossEth, uint256 fee)
    {
        uint256 x = t.virtualEthReserve() + t.ethReserve();
        uint256 y = t.curveSupply() - t.tokensSold();
        grossEth = (x * tokenAmount) / (y + tokenAmount);
        fee = (grossEth * t.feeBps()) / BPS;
        ethOut = grossEth - fee;
    }

    /// The constant product, recomputed from live state.
    function _k(FolioToken t) internal view returns (uint256) {
        return (t.virtualEthReserve() + t.ethReserve()) * (t.curveSupply() - t.tokensSold());
    }

    // -----------------------------------------------------------------------
    // The invariant every state change is checked against
    // -----------------------------------------------------------------------

    function _assertSolvent() internal view {
        _assertSolventOn(token);
    }

    function _assertSolventOn(FolioToken t) internal view {
        assertGe(
            t.getReserveBalance(),
            t.getOutstandingSellObligation(),
            "reserve cannot cover the sell-back obligation"
        );
        assertGe(
            address(t).balance,
            t.ethReserve() + t.feesAccrued(),
            "contract holds less ETH than it has promised"
        );
        assertEq(t.totalSupply(), t.tokensSold(), "supply and curve accounting diverged");
        assertLe(t.ethReserve(), t.maxReserveCap(), "reserve broke through its cap");
        assertLe(t.tokensSold(), t.curveSupply(), "curve issued more than its supply");
        assertGe(t.reserveHealthBps(), BPS, "reserve health fell below fully covered");
    }
}
