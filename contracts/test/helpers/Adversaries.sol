// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {FolioToken} from "../../src/FolioToken.sol";
import {CurveConfig} from "../../src/types/CurveConfig.sol";

/**
 * The hostile counterparties the stage-4 adversarial suite trades against.
 *
 * Stages 2 and 3 already ship `ReentrantTrader` and `SafetyProbe`, which each
 * fire a single re-entry from a payout hook. The contracts here go after the
 * cases those two cannot express: re-entry that retries rather than giving up
 * after one attempt, a holder that cannot receive ETH at all, and a launch
 * initialised outside the factory so it can hold a configuration the factory
 * would have refused.
 */

/**
 * A holder whose payout hook re-enters repeatedly rather than once.
 *
 * The existing probes disarm themselves on the first hook, which proves the
 * guard rejects one re-entry. This one keeps trying up to `maxAttempts` and
 * records every error it collects, so the test can show the guard holds for the
 * whole duration of the external call and not just its first instant. Each
 * attempt is wrapped in try/catch so the outer trade still settles and the test
 * reads the specific revert rather than inferring one from a blanket failure.
 */
contract PersistentReentrant {
    enum Mode {
        None,
        Buy,
        Sell,
        Claim,
        Alternate
    }

    FolioToken public token;
    Mode public mode;
    uint256 public maxAttempts;
    uint256 public attempts;
    uint256 public successes;
    bytes public lastError;
    bytes4 public firstErrorSelector;

    constructor(FolioToken token_) {
        token = token_;
    }

    function arm(Mode mode_, uint256 maxAttempts_) external {
        mode = mode_;
        maxAttempts = maxAttempts_;
        attempts = 0;
        successes = 0;
    }

    /// Point at a different launch — used when this contract has to *be* the
    /// creator of the launch it is attacking.
    function retargetTo(FolioToken token_) external {
        token = token_;
    }

    function doBuy(uint256 value, uint256 minOut) external {
        token.buy{value: value}(minOut);
    }

    function doSell(uint256 amount, uint256 minOut) external {
        token.sell(amount, minOut);
    }

    function doClaim() external {
        token.claimFees();
    }

    function _attempt(Mode m) private {
        if (m == Mode.Buy) {
            try token.buy{value: 0.01 ether}(0) {
                successes++;
            } catch (bytes memory err) {
                _record(err);
            }
        } else if (m == Mode.Sell) {
            try token.sell(1e18, 0) {
                successes++;
            } catch (bytes memory err) {
                _record(err);
            }
        } else if (m == Mode.Claim) {
            try token.claimFees() {
                successes++;
            } catch (bytes memory err) {
                _record(err);
            }
        }
    }

    function _record(bytes memory err) private {
        if (firstErrorSelector == bytes4(0)) firstErrorSelector = bytes4(err);
        lastError = err;
    }

    receive() external payable {
        while (attempts < maxAttempts) {
            attempts++;
            if (mode == Mode.Alternate) {
                _attempt(attempts % 2 == 1 ? Mode.Sell : Mode.Buy);
            } else {
                _attempt(mode);
            }
        }
    }
}

/**
 * A holder that cannot receive ETH: no `receive`, no `fallback`, no way in.
 *
 * It can still buy, because buying only sends ETH back when a purchase
 * overshoots the ceiling. Selling is what it cannot do — the payout call fails
 * and the whole trade reverts with `EthTransferFailed`. The point of the tests
 * that use it is that this is entirely a problem for this contract and for
 * nobody else: the reserve is untouched, and its tokens are still transferable
 * to an address that can take the money.
 */
contract EthRejector {
    FolioToken public token;

    constructor(FolioToken token_) {
        token = token_;
    }

    /// Point at a different launch — used when this contract has to *be* the
    /// creator of the launch it is attacking.
    function retargetTo(FolioToken token_) external {
        token = token_;
    }

    function doBuy(uint256 value, uint256 minOut) external returns (uint256) {
        return token.buy{value: value}(minOut);
    }

    function doSell(uint256 amount, uint256 minOut) external returns (uint256) {
        return token.sell(amount, minOut);
    }

    function doClaim() external returns (uint256) {
        return token.claimFees();
    }

    function moveTokens(address to, uint256 amount) external {
        token.transfer(to, amount);
    }

    /// Funding, without opening a general ETH path in: this accepts a deposit
    /// only when it is the one asking, which a payout never is.
    function fund() external payable {}
}

/**
 * A launch cloned and initialised outside `FolioFactory`.
 *
 * `FolioToken.initialize` is externally reachable on any fresh clone, and it
 * re-checks only the fields that could break the curve's arithmetic — the
 * factory's other bounds are platform policy and are not restated there. So a
 * clone made this way can hold a configuration no genuine launch could, which is
 * how the tests reach `FolioToken`'s defensive branches. It doubles as the
 * demonstration that such a clone is not registered in `isFolioToken`, which is
 * the check that tells a real launch from one of these.
 *
 * It stands in for the factory as far as the clone is concerned, so it answers
 * `paused()` — that is the one call the token makes back to its creator.
 */
contract RogueLauncher {
    bool public paused;

    function setPaused(bool p) external {
        paused = p;
    }

    function launch(
        address implementation,
        address creator_,
        string calldata name_,
        string calldata symbol_,
        uint256 wholeSupply,
        CurveConfig calldata config
    ) external returns (address clone) {
        clone = Clones.clone(implementation);
        FolioToken(clone).initialize(creator_, name_, symbol_, wholeSupply, config);
    }
}

/**
 * Forces ETH into a contract that has no way to accept it.
 *
 * `FolioToken` has no `receive`, so a plain transfer to it reverts — but
 * `selfdestruct` ignores that, and so does being named as a block's coinbase.
 * This is the standard way an attacker inflates a contract's balance behind its
 * back, and the reason `FolioToken` tracks `ethReserve` in storage rather than
 * reading `address(this).balance`.
 */
contract ForceFeeder {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}

/**
 * The sandwich attacker: buys in front of a victim, sells behind them.
 *
 * Kept as a contract rather than an EOA prank so the two legs and the profit
 * accounting sit in one place, and so the back-run can be run at whatever point
 * the test chooses.
 */
contract Sandwicher {
    FolioToken public token;
    uint256 public spent;
    uint256 public recovered;
    uint256 public heldTokens;

    constructor(FolioToken token_) {
        token = token_;
    }

    function frontRun(uint256 value) external {
        spent += value;
        heldTokens += token.buy{value: value}(0);
    }

    function backRun() external {
        uint256 amount = heldTokens;
        heldTokens = 0;
        recovered += token.sell(amount, 0);
    }

    /// Positive when the sandwich made money, zero when it did not.
    function profit() external view returns (uint256) {
        return recovered > spent ? recovered - spent : 0;
    }

    function loss() external view returns (uint256) {
        return spent > recovered ? spent - recovered : 0;
    }

    receive() external payable {}
}
