// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @notice The bonding curve terms a launch runs under.
 *
 * The factory holds one of these as the platform default and copies it into
 * every token at creation. The copy is what the token obeys for the rest of its
 * life: changing the factory default never moves the goalposts for a launch
 * that is already trading, and there is no setter anywhere that can reach a live
 * launch's terms.
 *
 * @param virtualEthReserve Starting `x` of the `x * y = k` curve, in wei. No real
 *        ETH backs it — it exists to give the curve a finite opening price. Since
 *        the whole supply starts on the curve, the opening market cap of a launch
 *        is exactly this number, whatever the token supply is.
 * @param maxReserveCap Hard ceiling on real ETH the curve will ever hold, in wei.
 *        This is the blast radius: a bug in the curve maths can never put more
 *        than this at risk per launch. The platform sets a default and a creator
 *        may choose a *lower* one at creation — never a higher one, so this bound
 *        can only ever be tightened by the party taking the risk.
 * @param graduationThreshold Real ETH reserve at which the curve stops accepting
 *        buys, in wei. Selling stays open. Zero disables it. Must not exceed
 *        `maxReserveCap`, and the factory clamps it down when a creator picks a
 *        cap below it. Migrating that liquidity to a DEX is deliberately not part
 *        of this contract yet — reaching the threshold only closes the curve and
 *        emits an event for off-chain tooling to act on.
 * @param feeBps Creator fee per leg, in basis points, charged on each buy and each
 *        sell. It is taken outside the curve: a buy's fee is skimmed before the
 *        ETH reaches the reserve, and a sell's fee is skimmed from the payout the
 *        curve produced. The reserve therefore never subsidises fees, which is
 *        what keeps the sell-back guarantee exact.
 * @param priceMoveAlertBps Sensitivity of the monitoring signal, in basis points.
 *        When a single trade moves the marginal price by at least this much, the
 *        token emits `LargePriceMove`. It does **not** block the trade — see the
 *        note on that event in `FolioToken`. Zero disables the signal. The move is
 *        measured against the lower of the two prices, so a doubling and a halving
 *        both read `10_000` and one threshold covers both directions.
 * @param sniperWindowSeconds How long after creation the per-wallet buy cap below
 *        applies, in seconds. Zero disables the whole mechanism, and is the
 *        setting every launch had before it existed. Bounded by
 *        `MAX_SNIPER_WINDOW_SECONDS` in the factory.
 * @param sniperMaxEthPerWallet The most ETH one address may spend on buys while
 *        that window is open, in wei, summed across however many buys it makes.
 *        Ignored entirely once the window closes, and meaningless when
 *        `sniperWindowSeconds` is zero.
 *
 *        This is the anti-sniper layer, and it is worth being exact about what it
 *        does and does not achieve. It bounds what any *one address* can take off
 *        the opening of the curve, where the price is lowest and a bot that is
 *        first in line would otherwise be free to take as much as it liked. It
 *        does not bound what one *person* can take, because nothing on chain can:
 *        an operator willing to fund N wallets gets N times the cap. What it buys
 *        is that they must pay for those wallets, and that the resulting holder
 *        distribution is visible to everyone reading the token — a snipe stops
 *        being a single silent transaction and becomes a fleet somebody has to
 *        build and cannot hide.
 *
 *        Deliberately kept outside the curve. A buy over the cap is clamped and
 *        the excess refunded, exactly as an over-cap buy is, so the ETH the curve
 *        prices is unchanged and `reserveHealthBps` still reads `10_000` on the
 *        nose. The sell-back guarantee does not know this mechanism exists.
 */
struct CurveConfig {
    uint256 virtualEthReserve;
    uint256 maxReserveCap;
    uint256 graduationThreshold;
    uint16 feeBps;
    uint16 priceMoveAlertBps;
    uint16 sniperWindowSeconds;
    uint256 sniperMaxEthPerWallet;
}
