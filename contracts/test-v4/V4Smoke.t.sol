// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// Toolchain gate: a real PoolManager has to deploy here before anything is
/// built against one.
contract V4SmokeTest is Test {
    function test_PoolManagerDeploys() public {
        IPoolManager pm = IPoolManager(address(new PoolManager(address(this))));
        assertTrue(address(pm) != address(0));
    }
}
