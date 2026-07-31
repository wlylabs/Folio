/**
 * The signal a settled trade sends to the rest of the page.
 *
 * Three panels on an article page read the same contract and go stale at the
 * same moment: the trade bar, the price history, and the creator's fee balance.
 * When a trade confirms, all three want to re-read — but they are siblings, not
 * a tree, and the trade bar has no business importing the other two.
 *
 * A window event is the smallest thing that decouples them. The trade bar fires
 * it after a receipt lands; whoever is mounted listens. Nothing breaks when a
 * listener isn't there, which is exactly the property wanted — the fee panel
 * only exists for the creator, and the history panel only for curve launches.
 *
 * `router.refresh()` covers the server-rendered half of the page; this covers
 * the client-fetched half, which Next has no way to know about.
 */
export const TRADE_SETTLED_EVENT = "folio:trade-settled";

/** Announce that a trade confirmed on chain. No-op outside the browser. */
export function announceTradeSettled(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TRADE_SETTLED_EVENT));
}
