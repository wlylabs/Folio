// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FolioToken} from "../src/FolioToken.sol";

/**
 * @title TradeProbe
 * @notice A throwaway caller used by `Pause` and `Unpause` to find out whether
 *         buying and selling actually revert, without broadcasting anything.
 *
 * ## Why this exists rather than a direct call from the script
 *
 * Two constraints meet here. A trade has to be attempted by something that
 * holds ETH, and `forge script` refuses to let a script reason about
 * `address(this)` — script contracts are ephemeral, so funding one and trading
 * from it is explicitly disallowed. A probe deployed inside the simulation has
 * neither problem: it is a normal contract with a normal address, `vm.deal` can
 * fund it, and it spends its own balance rather than the script's.
 *
 * Both helpers use a low-level `call` and hand back the raw revert data instead
 * of bubbling it, so the caller can name the selector — the difference between
 * "reverted because the platform is paused" and "reverted for some unrelated
 * reason" is the entire point of the check.
 *
 * Nothing here is ever broadcast. The probe is created during the local
 * simulation `forge script` runs against real chain state, so these trades
 * execute against the true post-pause state and are then thrown away.
 */
contract TradeProbe {
    /// @dev Attempts a buy, spending the probe's own ETH.
    function tryBuy(FolioToken token, uint256 ethIn) external returns (bool ok, bytes memory err) {
        (ok, err) = address(token).call{value: ethIn}(abi.encodeCall(FolioToken.buy, (0)));
    }

    /// @dev Attempts a sell.
    ///
    ///      `whenTradingActive` runs as a modifier, ahead of the function body,
    ///      so a paused token rejects this with `TradingPaused()` before it ever
    ///      looks at the caller's balance. That is what lets the probe prove the
    ///      pause reaches `sell` without having to hold any tokens first.
    function trySell(FolioToken token, uint256 amount)
        external
        returns (bool ok, bytes memory err)
    {
        (ok, err) = address(token).call(abi.encodeCall(FolioToken.sell, (amount, 0)));
    }

    /// @dev Buy refunds and sell proceeds land here.
    receive() external payable {}
}
