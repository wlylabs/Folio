// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FolioFactory} from "../../src/FolioFactory.sol";
import {FolioToken} from "../../src/FolioToken.sol";

/**
 * The call generator behind `FolioInvariant.t.sol`.
 *
 * Foundry's invariant runner calls this contract's external functions in a
 * random order with random arguments, and re-checks every `invariant_` in the
 * test after each one. The handler's job is to turn that noise into trades that
 * mostly *land*: an unbounded fuzzer aimed straight at `FolioToken` would spend
 * almost every call reverting on `ZeroEthIn` or `ExceedsCirculating` and would
 * explore nothing.
 *
 * So every entry point below clamps its arguments into a range that trades, and
 * checks the preconditions the token would have checked — headroom, graduation,
 * the pause, the caller's balance — skipping instead of reverting when they do
 * not hold. That keeps `fail_on_revert = true` on in the config, which is what
 * makes an unexpected revert a *failure* rather than a silently discarded run.
 * `skipped` and `reverted` are exposed so a run that quietly stopped trading
 * shows up as a call-summary anomaly rather than as a suspiciously green pass.
 *
 * ## The ghost accounting
 *
 * `tradersIn`, `tradersOut` and `feesClaimed` are measured as *deltas in the
 * token's own ETH balance* around each call, never inferred from the quote
 * functions. That matters: quoting is part of what is under test here, so an
 * accounting built on it could not detect a quote that lies. A balance delta is
 * the ground truth the EVM enforces.
 */
contract FolioHandler is Test {
    FolioFactory public factory;
    FolioToken public token;

    address[] public actors;
    address internal currentActor;

    // --- Ghost accounting, all measured from the token's ETH balance ---

    /// ETH that entered the token and stayed: `msg.value` less any refund.
    uint256 public tradersIn;
    /// ETH paid out to sellers, net of the fee withheld from them.
    uint256 public tradersOut;
    /// ETH the creator has withdrawn as accrued fees.
    uint256 public feesClaimed;
    /// ETH forced in from outside, which no accounting inside the token knows about.
    uint256 public forcedIn;

    /// Highest `k` seen. The curve product must never fall below it.
    uint256 public highWaterK;

    // --- Call census, so a vacuous run is visible ---

    uint256 public buys;
    uint256 public sells;
    uint256 public claims;
    uint256 public transfers;
    uint256 public pauses;
    uint256 public skipped;
    /// Fee claims correctly refused because the caller was not the creator.
    /// A deliberate outcome, kept apart from `reverted`.
    uint256 public deniedClaims;
    /// Calls that were expected to succeed and did not. Must stay at zero.
    uint256 public reverted;

    constructor(FolioFactory factory_, FolioToken token_, address[] memory actors_) {
        factory = factory_;
        token = token_;
        actors = actors_;
        highWaterK = _k();
    }

    receive() external payable {}

    modifier useActor(uint256 seed) {
        currentActor = actors[seed % actors.length];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
        _recordK();
    }

    // -----------------------------------------------------------------------
    // Trading
    // -----------------------------------------------------------------------

    function buy(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 1, 3 ether);

        if (token.tradingPaused() || token.graduated() || token.ethHeadroom() == 0) {
            skipped++;
            return;
        }
        // `vm.prank` debits the value from the pranked address, so it is the
        // actor's wallet that has to cover this, not the handler's.
        if (currentActor.balance < amount) {
            skipped++;
            return;
        }
        (uint256 quoted,,) = token.getBuyQuote(amount);
        if (quoted == 0) {
            skipped++;
            return;
        }

        uint256 before = address(token).balance;
        try token.buy{value: amount}(0) {
            buys++;
            // The delta is `msg.value` less whatever was refunded, without
            // having to trust the quote for the refund figure.
            tradersIn += address(token).balance - before;
        } catch {
            reverted++;
        }
    }

    /// A buy with a slippage floor taken from the live quote, so the guarded
    /// path is exercised as often as the unguarded one.
    function buyWithFloor(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 1, 3 ether);

        if (token.tradingPaused() || token.graduated() || token.ethHeadroom() == 0) {
            skipped++;
            return;
        }
        // `vm.prank` debits the value from the pranked address, so it is the
        // actor's wallet that has to cover this, not the handler's.
        if (currentActor.balance < amount) {
            skipped++;
            return;
        }
        (uint256 quoted,,) = token.getBuyQuote(amount);
        if (quoted == 0) {
            skipped++;
            return;
        }

        uint256 before = address(token).balance;
        try token.buy{value: amount}(quoted) {
            buys++;
            tradersIn += address(token).balance - before;
        } catch {
            reverted++;
        }
    }

    function sell(uint256 actorSeed, uint256 fractionBps) external useActor(actorSeed) {
        uint256 held = token.balanceOf(currentActor);
        if (held == 0 || token.tradingPaused()) {
            skipped++;
            return;
        }

        uint256 amount = (held * bound(fractionBps, 1, 10_000)) / 10_000;
        if (amount == 0 || token.getSellPrice(amount) == 0) {
            skipped++;
            return;
        }

        uint256 before = address(token).balance;
        try token.sell(amount, 0) {
            sells++;
            // The contract's balance falls by exactly the seller's net payout;
            // the fee stays behind, so it is not counted as an outflow here.
            tradersOut += before - address(token).balance;
        } catch {
            reverted++;
        }
    }

    /// A full exit, which is the ordering that stresses the reserve hardest.
    function sellEverything(uint256 actorSeed) external useActor(actorSeed) {
        uint256 held = token.balanceOf(currentActor);
        if (held == 0 || token.tradingPaused() || token.getSellPrice(held) == 0) {
            skipped++;
            return;
        }

        uint256 before = address(token).balance;
        try token.sell(held, 0) {
            sells++;
            tradersOut += before - address(token).balance;
        } catch {
            reverted++;
        }
    }

    // -----------------------------------------------------------------------
    // Everything else that touches state
    // -----------------------------------------------------------------------

    /// Tokens moving between holders must not disturb the curve at all.
    function transfer(uint256 fromSeed, uint256 toSeed, uint256 fractionBps)
        external
        useActor(fromSeed)
    {
        address to = actors[toSeed % actors.length];
        uint256 held = token.balanceOf(currentActor);
        if (held == 0 || to == currentActor) {
            skipped++;
            return;
        }

        uint256 amount = (held * bound(fractionBps, 1, 10_000)) / 10_000;
        if (amount == 0) {
            skipped++;
            return;
        }

        try token.transfer(to, amount) {
            transfers++;
        } catch {
            reverted++;
        }
    }

    function claimFees(uint256 seed) external {
        if (token.feesAccrued() == 0) {
            skipped++;
            return;
        }

        // Most of the time the creator claims. Occasionally an actor tries it
        // instead, which must be refused — that refusal is a *result*, not an
        // accident, so it gets its own counter rather than being lumped in with
        // `reverted`, which is reserved for things that were supposed to work.
        if (seed % 8 == 0) {
            address intruder = actors[seed % actors.length];
            if (intruder != token.creator()) {
                uint256 feesBefore = token.feesAccrued();
                vm.prank(intruder);
                try token.claimFees() {
                    revert("a non-creator claimed fees");
                } catch (bytes memory err) {
                    require(
                        bytes4(err) == FolioToken.NotCreator.selector,
                        "non-creator claim failed for the wrong reason"
                    );
                    deniedClaims++;
                }
                require(token.feesAccrued() == feesBefore, "a refused claim moved the fee balance");
                return;
            }
        }

        uint256 before = address(token).balance;
        vm.prank(token.creator());
        try token.claimFees() {
            claims++;
            feesClaimed += before - address(token).balance;
        } catch {
            reverted++;
        }
        _recordK();
    }

    /// The emergency stop, engaged rarely so that runs are mostly spent trading.
    function togglePause(uint256 seed) external {
        bool paused = factory.paused();
        if (!paused && seed % 12 != 0) {
            skipped++;
            return;
        }

        vm.prank(factory.owner());
        if (paused) {
            try factory.unpause() {
                pauses++;
            } catch {
                reverted++;
            }
        } else {
            try factory.pause() {
                pauses++;
            } catch {
                reverted++;
            }
        }
    }

    /// ETH shoved into the token from outside its accounting. Everything the
    /// curve computes must be indifferent to it.
    function forceFeed(uint256 amount) external {
        amount = bound(amount, 1, 1 ether);
        if (address(this).balance < amount) {
            skipped++;
            return;
        }
        vm.deal(address(token), address(token).balance + amount);
        vm.deal(address(this), address(this).balance - amount);
        forcedIn += amount;
    }

    // -----------------------------------------------------------------------
    // Views used by the invariants
    // -----------------------------------------------------------------------

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function _k() internal view returns (uint256) {
        return (token.virtualEthReserve() + token.ethReserve())
            * (token.curveSupply() - token.tokensSold());
    }

    function _recordK() internal {
        uint256 k = _k();
        if (k > highWaterK) highWaterK = k;
    }

    function currentK() external view returns (uint256) {
        return _k();
    }
}
