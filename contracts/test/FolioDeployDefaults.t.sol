// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployFactory} from "../script/DeployFactory.s.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";

/// @dev `_configFromEnv` is internal and `run` belongs to `forge script`. A
///      subclass with one forwarder is the whole harness needed, the same shape
///      `FolioScriptRecordTest` uses.
contract ConfigReader is DeployFactory {
    function read() external view returns (CurveConfig memory) {
        return _configFromEnv();
    }
}

/**
 * @title FolioDeployDefaultsTest
 * @notice What the deploy script ships when nobody sets an environment variable.
 *
 * These are the terms a mainnet factory gets if an operator takes the defaults,
 * and they are the only numbers in the repository that reach a real chain without
 * a test between them and it — `run` is driven by `forge script`, so nothing else
 * here ever executes them. Every property below is one the README states in prose
 * about the shipped configuration; the point of the file is that changing a
 * default without changing the claim breaks a test rather than a launch.
 */
contract FolioDeployDefaultsTest is Test {
    ConfigReader internal reader;
    CurveConfig internal shipped;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");

    uint256 internal constant SUPPLY = 1_000_000_000;

    function setUp() public {
        reader = new ConfigReader();
        shipped = reader.read();
    }

    /// The first requirement, and the one a typo breaks: a factory will accept
    /// them. `_validateConfig` runs in the constructor, so this is the whole check.
    function test_Defaults_AreAcceptedByTheFactory() public {
        FolioFactory f = new FolioFactory(owner, shipped);
        (uint256 virt, uint256 cap, uint256 threshold,,,,) = f.defaultConfig();
        assertEq(virt, shipped.virtualEthReserve);
        assertEq(cap, shipped.maxReserveCap);
        assertEq(threshold, shipped.graduationThreshold);
    }

    /**
     * Aggression is `((V + threshold) / V) ** 2` and the README says the shipped
     * pair is 9x. That claim survives only while the two move together, which is
     * exactly the mistake this catches: raising the threshold alone to deepen the
     * post-graduation pool would quietly make the curve 36x for late buyers.
     */
    function test_Defaults_AreANineTimesCurve() public view {
        uint256 v = shipped.virtualEthReserve;
        uint256 ratio = (v + shipped.graduationThreshold) / v;
        assertEq(ratio * ratio, 9, "the shipped curve is no longer 9x open-to-graduation");
    }

    /// The cap is the blast radius and has to leave room above the threshold, or
    /// a launch hits its ceiling before it can graduate.
    function test_Defaults_CapLeavesRoomAboveTheThreshold() public view {
        assertGt(
            shipped.maxReserveCap,
            shipped.graduationThreshold,
            "the cap must not bind before graduation does"
        );
    }

    /**
     * The threshold is the entire real reserve, so it is the depth of any market
     * that follows the curve. Extracting `X` from a constant-product pool of depth
     * `D` leaves the price at `((D - X) / D) ** 2`, and the README publishes a
     * table off that. Pinned at a 1 ETH sell costing under a quarter, which is the
     * line between "thin" and "broken on arrival".
     */
    function test_Defaults_GraduateIntoATradeableDepth() public view {
        uint256 d = shipped.graduationThreshold;
        assertGe(d, 1 ether, "a pool shallower than the trade size has no price to move");

        // ((D - 1e18) / D)^2 in basis points, without leaving integer maths.
        uint256 remainingBps = ((d - 1 ether) * 10_000) / d;
        uint256 priceAfterBps = (remainingBps * remainingBps) / 10_000;
        assertGt(priceAfterBps, 7_500, "a 1 ETH sell would cost more than 25% at this depth");
    }

    /// The opening window ships on, and its cap stays a small fraction of the
    /// curve — the ratio the README quotes, not an absolute that drifts out of
    /// meaning when the threshold moves.
    function test_Defaults_OpeningWindowIsOnAndProportionate() public view {
        assertGt(shipped.sniperWindowSeconds, 0, "the opening window ships switched off");
        assertLe(
            (shipped.sniperMaxEthPerWallet * 100) / shipped.graduationThreshold,
            5,
            "one wallet may take more than 5% of the curve during the opening"
        );
    }

    /// End to end on the shipped terms: launch, buy, sell, still solvent. Cheap
    /// insurance that the defaults are not merely valid but usable.
    function test_Defaults_ProduceALaunchThatTrades() public {
        FolioFactory f = new FolioFactory(owner, shipped);

        vm.prank(creator);
        FolioToken t = FolioToken(f.createToken("Shipped", "SHP", SUPPLY));

        // The opening market cap of any launch is the virtual reserve, whatever
        // supply was chosen — the README's headline claim about the curve.
        assertEq(t.marketCap(), shipped.virtualEthReserve);

        vm.deal(alice, 100 ether);
        vm.prank(alice);
        t.buy{value: shipped.sniperMaxEthPerWallet}(0);

        // Read before the prank: a call inside the argument list is itself the
        // pranked call, and the sell would then come from this contract.
        uint256 held = t.balanceOf(alice);
        assertGt(held, 0);

        vm.prank(alice);
        t.sell(held / 2, 0);

        assertGe(t.getReserveBalance(), t.getOutstandingSellObligation());
        assertEq(t.reserveHealthBps(), 10_000);
    }
}
