// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @notice The bonding curve terms a launch runs under.
 *
 * The factory holds one of these as the platform default and copies it into
 * every token at creation. The copy is what the token obeys for the rest of its
 * life: changing the factory default never moves the goalposts for a launch
 * that is already trading.
 *
 * @param virtualEthReserve Starting `x` of the `x * y = k` curve, in wei. No real
 *        ETH backs it — it exists to give the curve a finite opening price. Since
 *        the whole supply starts on the curve, the opening market cap of a launch
 *        is exactly this number, whatever the token supply is.
 * @param ethCap Hard ceiling on real ETH the curve will ever take in, in wei.
 *        This is the blast radius: a bug in the curve maths can never put more
 *        than this at risk per launch.
 * @param graduationThreshold Real ETH reserve at which the curve stops accepting
 *        buys, in wei. Selling stays open. Zero disables it. Must not exceed
 *        `ethCap`. Migrating that liquidity to a DEX is deliberately not part of
 *        this contract yet — reaching the threshold only closes the curve and
 *        emits an event for off-chain tooling to act on.
 * @param feeBps Creator fee per leg, in basis points, charged on each buy and each
 *        sell. It is taken outside the curve: a buy's fee is skimmed before the
 *        ETH reaches the reserve, and a sell's fee is skimmed from the payout the
 *        curve produced. The reserve therefore never subsidises fees, which is
 *        what keeps the sell-back guarantee exact.
 */
struct CurveConfig {
    uint256 virtualEthReserve;
    uint256 ethCap;
    uint256 graduationThreshold;
    uint16 feeBps;
}
