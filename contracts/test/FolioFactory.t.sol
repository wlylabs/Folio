// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";
// The contract being replaced, kept only as the gas baseline below.
import {FolioSale} from "../FolioSale.sol";

/**
 * Stage 1: creating launches.
 *
 * Covers the proxy plumbing (does a clone come up correctly initialized, and can
 * it be initialized twice), the input bounds, the owner's two levers and their
 * limits, and the gas claim that motivated the rewrite in the first place.
 * Trading is stage 2 and is not exercised here.
 */
contract FolioFactoryTest is Test {
    FolioFactory internal factory;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant SUPPLY = 1_000_000;

    /// @dev keccak of the TokenCreated signature, for log matching.
    bytes32 internal constant TOKEN_CREATED_TOPIC = keccak256(
        "TokenCreated(address,address,string,string,uint256,(uint256,uint256,uint256,uint16))"
    );

    function _config() internal pure returns (CurveConfig memory) {
        return CurveConfig({
            virtualEthReserve: 2 ether,
            ethCap: 5 ether,
            graduationThreshold: 4 ether,
            feeBps: 100
        });
    }

    function setUp() public {
        factory = new FolioFactory(owner, _config());
    }

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    function test_Constructor_SetsOwnerAndConfig() public view {
        assertEq(factory.owner(), owner);
        (uint256 virt, uint256 cap, uint256 threshold, uint16 fee) = factory.defaultConfig();
        assertEq(virt, 2 ether);
        assertEq(cap, 5 ether);
        assertEq(threshold, 4 ether);
        assertEq(fee, 100);
        assertEq(factory.tokenCount(), 0);
    }

    function test_Constructor_DeploysImplementation() public view {
        address impl = factory.implementation();
        assertTrue(impl != address(0));
        assertTrue(impl.code.length > 0);
    }

    /// The shared logic contract must be unusable on its own. If it could be
    /// initialized, someone could take it over and (once trading exists) mislead
    /// anyone who read it as if it were a launch.
    function test_Implementation_CannotBeInitialized() public {
        FolioToken impl = FolioToken(factory.implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(creator, "Hijack", "HJK", SUPPLY, _config());
    }

    function test_Constructor_RevertsOnBadConfig() public {
        CurveConfig memory bad = _config();
        bad.feeBps = 501;
        vm.expectRevert(FolioFactory.FeeTooHigh.selector);
        new FolioFactory(owner, bad);

        bad = _config();
        bad.ethCap = 0;
        vm.expectRevert(FolioFactory.InvalidEthCap.selector);
        new FolioFactory(owner, bad);
    }

    // -----------------------------------------------------------------------
    // createToken
    // -----------------------------------------------------------------------

    function test_CreateToken_SetsMetadataAndCurveState() public {
        FolioToken token = _create("Midnight Kettle", "KETL", SUPPLY);

        assertEq(token.name(), "Midnight Kettle");
        assertEq(token.symbol(), "KETL");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 0, "nothing is minted until someone buys");
        assertEq(token.creator(), creator);
        assertEq(token.factory(), address(factory));

        assertEq(token.curveSupply(), SUPPLY * 1e18);
        assertEq(token.tokensSold(), 0);
        assertEq(token.ethReserve(), 0);
        assertEq(token.feesAccrued(), 0);
        assertFalse(token.graduated());
    }

    /// The whole supply is curve inventory, and none of it exists yet: tokens are
    /// minted one buy at a time. Nothing is pre-allocated to the creator, so there
    /// is no insider bag to dump into the first buyers, and the contract does not
    /// show up as its own largest holder.
    function test_CreateToken_PutsEntireSupplyOnTheCurveUnminted() public {
        FolioToken token = _create("Midnight Kettle", "KETL", SUPPLY);
        assertEq(token.curveSupply(), SUPPLY * 1e18);
        assertEq(token.curveTokenReserve(), SUPPLY * 1e18);
        assertEq(token.totalSupply(), 0);
        assertEq(token.balanceOf(address(token)), 0);
        assertEq(token.balanceOf(creator), 0);
    }

    function test_CreateToken_CopiesConfig() public {
        FolioToken token = _create("Midnight Kettle", "KETL", SUPPLY);
        assertEq(token.virtualEthReserve(), 2 ether);
        assertEq(token.ethCap(), 5 ether);
        assertEq(token.graduationThreshold(), 4 ether);
        assertEq(token.feeBps(), 100);
    }

    /// The point of snapshotting: the platform cannot retroactively raise the fee
    /// on a launch that is already trading.
    function test_CreateToken_LaterConfigChangeDoesNotTouchLiveLaunch() public {
        FolioToken token = _create("Midnight Kettle", "KETL", SUPPLY);

        CurveConfig memory next = _config();
        next.feeBps = 500;
        next.ethCap = 50 ether;
        vm.prank(owner);
        factory.setDefaultConfig(next);

        assertEq(token.feeBps(), 100);
        assertEq(token.ethCap(), 5 ether);

        FolioToken later = _create("Later", "LTR", SUPPLY);
        assertEq(later.feeBps(), 500);
        assertEq(later.ethCap(), 50 ether);
    }

    function test_CreateToken_RegistersAndCounts() public {
        FolioToken a = _create("A", "A", SUPPLY);
        FolioToken b = _create("B", "B", SUPPLY);

        assertTrue(factory.isFolioToken(address(a)));
        assertTrue(factory.isFolioToken(address(b)));
        assertFalse(factory.isFolioToken(stranger));
        assertEq(factory.tokenCount(), 2);
    }

    function test_CreateToken_EmitsEvent() public {
        vm.recordLogs();
        vm.prank(creator);
        address token = factory.createToken("Midnight Kettle", "KETL", SUPPLY);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != TOKEN_CREATED_TOPIC) continue;
            found = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), creator);
            (string memory name_, string memory symbol_, uint256 supply, CurveConfig memory cfg) =
                abi.decode(logs[i].data, (string, string, uint256, CurveConfig));
            assertEq(name_, "Midnight Kettle");
            assertEq(symbol_, "KETL");
            assertEq(supply, SUPPLY * 1e18);
            assertEq(cfg.feeBps, 100);
            assertEq(cfg.virtualEthReserve, 2 ether);
        }
        assertTrue(found, "TokenCreated not emitted");
    }

    function test_CreateToken_RevertsWhenPaused() public {
        vm.prank(owner);
        factory.pause();

        vm.prank(creator);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.createToken("Midnight Kettle", "KETL", SUPPLY);

        vm.prank(owner);
        factory.unpause();
        _create("Midnight Kettle", "KETL", SUPPLY);
    }

    function test_CreateToken_RevertsOnEmptyName() public {
        vm.prank(creator);
        vm.expectRevert(FolioFactory.EmptyName.selector);
        factory.createToken("", "KETL", SUPPLY);
    }

    function test_CreateToken_RevertsOnEmptySymbol() public {
        vm.prank(creator);
        vm.expectRevert(FolioFactory.EmptySymbol.selector);
        factory.createToken("Midnight Kettle", "", SUPPLY);
    }

    function test_CreateToken_RevertsOnOverlongName() public {
        string memory long = new string(65);
        vm.prank(creator);
        vm.expectRevert(FolioFactory.NameTooLong.selector);
        factory.createToken(long, "KETL", SUPPLY);
    }

    function test_CreateToken_RevertsOnOverlongSymbol() public {
        string memory long = new string(17);
        vm.prank(creator);
        vm.expectRevert(FolioFactory.SymbolTooLong.selector);
        factory.createToken("Midnight Kettle", long, SUPPLY);
    }

    function test_CreateToken_RevertsOnZeroSupply() public {
        vm.prank(creator);
        vm.expectRevert(FolioFactory.InvalidSupply.selector);
        factory.createToken("Midnight Kettle", "KETL", 0);
    }

    function test_CreateToken_RevertsAboveMaxSupply() public {
        // Read the constant before arming expectRevert: it applies to the very
        // next call, and a getter call would consume it.
        uint256 tooMuch = factory.MAX_WHOLE_SUPPLY() + 1;
        vm.prank(creator);
        vm.expectRevert(FolioFactory.InvalidSupply.selector);
        factory.createToken("Midnight Kettle", "KETL", tooMuch);
    }

    /**
     * A supply larger than the virtual reserve *in wei* would floor the opening
     * price to zero, i.e. give the first tokens away. The factory refuses instead.
     *
     * Note this only binds for a thin virtual reserve — under the default 2 ETH
     * the supply ceiling (`MAX_WHOLE_SUPPLY`) is the tighter limit by three orders
     * of magnitude, so the config here is deliberately pushed to the floor.
     */
    function test_CreateToken_RevertsWhenSupplyOutrunsVirtualReserve() public {
        uint256 thin = factory.MIN_VIRTUAL_ETH_RESERVE();
        CurveConfig memory cfg = _config();
        cfg.virtualEthReserve = thin;
        vm.prank(owner);
        factory.setDefaultConfig(cfg);

        vm.prank(creator);
        vm.expectRevert(FolioFactory.SupplyTooLargeForCurve.selector);
        factory.createToken("Midnight Kettle", "KETL", thin + 1);
    }

    function test_CreateToken_AcceptsSupplyExactlyAtCurveLimit() public {
        uint256 thin = factory.MIN_VIRTUAL_ETH_RESERVE();
        CurveConfig memory cfg = _config();
        cfg.virtualEthReserve = thin;
        vm.prank(owner);
        factory.setDefaultConfig(cfg);

        FolioToken token = _create("Edge", "EDGE", thin);
        assertEq(token.currentPrice(), 1, "one wei per whole token is the floor");
    }

    // -----------------------------------------------------------------------
    // Initialization safety
    // -----------------------------------------------------------------------

    function test_Initialize_CannotRunTwice() public {
        FolioToken token = _create("Midnight Kettle", "KETL", SUPPLY);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        token.initialize(stranger, "Stolen", "STL", SUPPLY, _config());
    }

    /// Anyone can clone the implementation themselves — it is public bytecode. The
    /// registry is what distinguishes a real launch, and this pins that behaviour.
    function test_RogueCloneIsNotRegistered() public {
        address rogue = Clones.clone(factory.implementation());
        FolioToken(rogue).initialize(stranger, "Fake", "FAKE", SUPPLY, _config());

        assertFalse(factory.isFolioToken(rogue));
        assertEq(FolioToken(rogue).factory(), address(this));
        // And its emergency stop answers to its own maker, not the platform —
        // another reason the registry, not the token, is the source of truth.
        assertEq(FolioToken(rogue).creator(), stranger);
    }

    function test_Initialize_RevertsOnZeroCreator() public {
        address clone = Clones.clone(factory.implementation());
        vm.expectRevert(FolioToken.ZeroAddress.selector);
        FolioToken(clone).initialize(address(0), "X", "X", SUPPLY, _config());
    }

    function test_Initialize_RevertsOnZeroSupply() public {
        address clone = Clones.clone(factory.implementation());
        vm.expectRevert(FolioToken.InvalidSupply.selector);
        FolioToken(clone).initialize(creator, "X", "X", 0, _config());
    }

    /// initialize re-validates instead of trusting the caller, because on a clone
    /// it is an externally reachable function.
    function test_Initialize_RevertsOnDegenerateConfig() public {
        address clone = Clones.clone(factory.implementation());
        CurveConfig memory bad = _config();
        bad.virtualEthReserve = 0;
        vm.expectRevert(FolioToken.InvalidConfig.selector);
        FolioToken(clone).initialize(creator, "X", "X", SUPPLY, bad);

        clone = Clones.clone(factory.implementation());
        bad = _config();
        bad.graduationThreshold = bad.ethCap + 1;
        vm.expectRevert(FolioToken.InvalidConfig.selector);
        FolioToken(clone).initialize(creator, "X", "X", SUPPLY, bad);
    }

    // -----------------------------------------------------------------------
    // Owner controls
    // -----------------------------------------------------------------------

    function test_SetDefaultConfig_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.setDefaultConfig(_config());
    }

    /// The owner is fenced by the same constants as anyone else.
    function test_SetDefaultConfig_RejectsOutOfBoundsFee() public {
        CurveConfig memory bad = _config();
        bad.feeBps = factory.MAX_FEE_BPS() + 1;
        vm.prank(owner);
        vm.expectRevert(FolioFactory.FeeTooHigh.selector);
        factory.setDefaultConfig(bad);
    }

    function test_SetDefaultConfig_RejectsOutOfBoundsReserveAndCap() public {
        CurveConfig memory bad = _config();
        bad.virtualEthReserve = factory.MIN_VIRTUAL_ETH_RESERVE() - 1;
        vm.prank(owner);
        vm.expectRevert(FolioFactory.InvalidVirtualReserve.selector);
        factory.setDefaultConfig(bad);

        bad = _config();
        bad.virtualEthReserve = factory.MAX_VIRTUAL_ETH_RESERVE() + 1;
        vm.prank(owner);
        vm.expectRevert(FolioFactory.InvalidVirtualReserve.selector);
        factory.setDefaultConfig(bad);

        bad = _config();
        bad.ethCap = factory.MAX_ETH_CAP() + 1;
        vm.prank(owner);
        vm.expectRevert(FolioFactory.InvalidEthCap.selector);
        factory.setDefaultConfig(bad);

        bad = _config();
        bad.graduationThreshold = bad.ethCap + 1;
        vm.prank(owner);
        vm.expectRevert(FolioFactory.InvalidGraduationThreshold.selector);
        factory.setDefaultConfig(bad);
    }

    function test_Pause_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.pause();

        vm.prank(owner);
        factory.pause();
        assertTrue(factory.paused());

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        factory.unpause();
    }

    /// Every launch reads the stop from the factory, so one switch covers all of
    /// them. Stage 2 is where buy/sell actually consult this.
    function test_TokenReadsPauseFromFactory() public {
        FolioToken token = _create("Midnight Kettle", "KETL", SUPPLY);
        assertFalse(token.tradingPaused());

        vm.prank(owner);
        factory.pause();
        assertTrue(token.tradingPaused());
    }

    function test_OwnershipTransferIsTwoStep() public {
        vm.prank(owner);
        factory.transferOwnership(stranger);
        assertEq(factory.owner(), owner, "not transferred until accepted");

        vm.prank(stranger);
        factory.acceptOwnership();
        assertEq(factory.owner(), stranger);
    }

    // -----------------------------------------------------------------------
    // Curve parameterisation
    // -----------------------------------------------------------------------

    /// The property that makes one platform-wide config workable: because the
    /// whole supply sits on the curve, the opening market cap is the virtual
    /// reserve no matter what supply a creator picks. A creator choosing a huge
    /// supply gets a low unit price, not a bigger valuation.
    function test_OpeningMarketCapEqualsVirtualReserve() public {
        uint256[3] memory supplies = [uint256(1_000), 1_000_000, 1_000_000_000];
        for (uint256 i = 0; i < supplies.length; i++) {
            FolioToken token = _create("T", "T", supplies[i]);
            assertApproxEqRel(token.marketCap(), 2 ether, 1e12);
        }
    }

    function testFuzz_OpeningPriceIsNeverZero(uint256 wholeSupply) public {
        wholeSupply = bound(wholeSupply, 1, factory.MAX_WHOLE_SUPPLY());
        FolioToken token = _create("T", "T", wholeSupply);
        assertGt(token.currentPrice(), 0);
        assertEq(token.ethHeadroom(), 4 ether);
    }

    function test_EthHeadroomUsesTheBindingCeiling() public {
        // Threshold below cap: threshold binds.
        FolioToken token = _create("T", "T", SUPPLY);
        assertEq(token.ethHeadroom(), 4 ether);

        // Threshold disabled: the cap binds.
        CurveConfig memory noGrad = _config();
        noGrad.graduationThreshold = 0;
        vm.prank(owner);
        factory.setDefaultConfig(noGrad);
        FolioToken uncapped = _create("U", "U", SUPPLY);
        assertEq(uncapped.ethHeadroom(), 5 ether);
    }

    // -----------------------------------------------------------------------
    // Gas: the reason this rewrite exists
    // -----------------------------------------------------------------------

    /**
     * The reason for the rewrite, measured against what it replaces.
     *
     * `FolioSale` is the live contract: one full ERC20 deployed per launch, all
     * setup in its constructor. `createToken` is the new path and does strictly
     * more work — clone, initialize, registry write, counter, event.
     *
     * The bare `new FolioToken()` figure is printed too, so the split is visible:
     * most of what the clone pays is storage writes that any design has to pay,
     * and what the clone actually removes is the ~1M gas code deposit.
     */
    function test_Gas_CloneIsCheaperThanTheLegacyFullDeploy() public {
        vm.prank(creator);
        uint256 before = gasleft();
        factory.createToken("Midnight Kettle", "KETL", SUPPLY);
        uint256 cloneGas = before - gasleft();

        before = gasleft();
        new FolioSale("Midnight Kettle", "KETL", SUPPLY, 0.0002 ether, creator);
        uint256 legacyGas = before - gasleft();

        before = gasleft();
        new FolioToken();
        uint256 bareDeployGas = before - gasleft();

        emit log_named_uint("new: createToken, clone + full setup", cloneGas);
        emit log_named_uint("old: FolioSale full deploy", legacyGas);
        emit log_named_uint("reference: bare FolioToken deploy, no setup", bareDeployGas);
        emit log_named_uint("saved per launch", legacyGas - cloneGas);
        emit log_named_uint("saved, percent", (legacyGas - cloneGas) * 100 / legacyGas);

        assertLt(cloneGas, legacyGas / 2, "clone path should more than halve the old cost");
        // Guards against a later change quietly reintroducing a full deploy.
        assertLt(cloneGas, 400_000);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _create(string memory name_, string memory symbol_, uint256 wholeSupply)
        internal
        returns (FolioToken)
    {
        vm.prank(creator);
        return FolioToken(factory.createToken(name_, symbol_, wholeSupply));
    }
}
