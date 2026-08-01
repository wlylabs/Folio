// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FolioFactory} from "../src/FolioFactory.sol";
import {FolioToken} from "../src/FolioToken.sol";
import {FolioMigrator} from "../src/FolioMigrator.sol";
import {IFolioFactory} from "../src/interfaces/IFolioFactory.sol";
import {CurveConfig} from "../src/types/CurveConfig.sol";

/**
 * @title FolioMigrationForkTest
 * @notice The migration, run against the real Uniswap v4 on Robinhood Chain.
 *
 * `FolioMigration.t.sol` deploys its own `PoolManager` and proves the logic. It
 * cannot prove the thing that actually breaks a mainnet deploy: that the address
 * this repository believes is the PoolManager holds a PoolManager, on chain 4663,
 * today. That is what this file is for, and it is why it needs a fork rather than
 * a local EVM.
 *
 * The address below comes from Uniswap's own `sdks` package rather than a doc
 * page. {test_Fork_PoolManagerAddressHoldsAPoolManager} is the assertion that
 * turns that into something checked instead of something believed — if Uniswap
 * ever redeploys, this fails and the constant gets updated before a migrator is
 * ever pointed at the wrong contract.
 *
 * Skips itself, loudly, when no RPC is configured. A developer without one still
 * gets the local suite; CI supplies `ROBINHOOD_MAINNET_RPC_URL` and gets both.
 */
contract FolioMigrationForkTest is Test {
    using StateLibrary for IPoolManager;

    /// @dev Uniswap v4 `PoolManager` on Robinhood Chain, from
    ///      `Uniswap/sdks` → `sdk-core/src/addresses.ts` → `ROBINHOOD_ADDRESSES`.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;

    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant TICK_SPACING = 200;
    uint256 internal constant SUPPLY = 1_000_000_000;

    address internal owner = makeAddr("owner");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_MAINNET_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            console2.log("ROBINHOOD_MAINNET_RPC_URL unset - fork checks skipped.");
            return;
        }
        vm.createSelectFork(rpc);
        forked = true;
    }

    /// The whole reason this file exists.
    function test_Fork_PoolManagerAddressHoldsAPoolManager() public view {
        if (!forked) return;

        assertEq(block.chainid, ROBINHOOD_CHAIN_ID, "forked the wrong chain");
        assertGt(POOL_MANAGER.code.length, 0, "no contract at the recorded PoolManager address");

        // Answers the interface, not merely occupied. `getSlot0` reads through
        // `extsload`, so a contract without one reverts here rather than quietly
        // returning zeroes — which is what makes this a check and not a formality.
        PoolKey memory probe = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(1)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        IPoolManager(POOL_MANAGER).getSlot0(probe.toId());
    }

    /// End to end against the live manager: launch, graduate, migrate, and read
    /// the pool back out of the real singleton.
    function test_Fork_FullMigrationAgainstLiveUniswap() public {
        if (!forked) return;

        IPoolManager manager = IPoolManager(POOL_MANAGER);

        FolioFactory factory = new FolioFactory(owner, _config(address(0)));
        FolioMigrator migrator =
            new FolioMigrator(manager, IFolioFactory(address(factory)), POOL_FEE, TICK_SPACING);

        vm.prank(owner);
        factory.setDefaultConfig(_config(address(migrator)));

        vm.prank(creator);
        FolioToken token = FolioToken(factory.createToken("Fork Kettle", "FKTL", SUPPLY));

        vm.deal(alice, 100 ether);
        vm.prank(alice);
        token.buy{value: 20 ether}(0);
        assertTrue(token.graduated());

        uint256 closingPrice = token.currentPrice();
        (PoolKey memory key, uint128 liquidity) = migrator.migrate(token);

        assertGt(liquidity, 0, "no liquidity minted on the live manager");
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(key.toId());
        assertGt(sqrtPriceX96, 0, "the pool was not initialized on the live manager");
        assertEq(manager.getLiquidity(key.toId()), liquidity);

        assertTrue(token.migrated());
        assertEq(token.ethReserve(), 0);
        assertEq(token.migrationPrice(), closingPrice);
    }

    function _config(address migrator_) internal pure returns (CurveConfig memory) {
        return CurveConfig({
            virtualEthReserve: 5 ether,
            maxReserveCap: 12 ether,
            graduationThreshold: 10 ether,
            feeBps: 100,
            priceMoveAlertBps: 10_000,
            sniperWindowSeconds: 0,
            sniperMaxEthPerWallet: 0,
            migrator: migrator_
        });
    }
}
