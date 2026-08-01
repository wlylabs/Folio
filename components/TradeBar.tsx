"use client";

import CurveTradeBar from "@/components/CurveTradeBar";
import LegacySaleBar from "@/components/LegacySaleBar";
import { useDeclarePreferredChain } from "@/lib/preferredChain";
import type { Token, TokenStats } from "@/lib/types";

/**
 * Picks the trade panel that matches what is actually deployed at this address.
 *
 * Which one a listing gets is discovered from the contract (see
 * lib/tokenStats.ts), not stored in the database — so a launch keeps the panel
 * that describes it honestly whether it was created before or after the factory
 * existed, with no migration column to keep in step.
 *
 * On a phone the panel is docked to the bottom edge, because it is the reason
 * the page exists and should never be more than a thumb away. From 1024px it
 * settles into the article rail beside the contract data — same markup either
 * way, the breakpoint lives in globals.css.
 *
 * Also where a token page says which chain it is about, since it is on every
 * one of them and already holds the listing. A wallet that connects here on an
 * unsupported chain is moved to this token's chain rather than the app's
 * default — the reader came to trade this token, not another one.
 */
export default function TradeBar({ token, stats }: { token: Token; stats: TokenStats }) {
  useDeclarePreferredChain(token.chain);

  if (stats.kind === "curve") return <CurveTradeBar token={token} stats={stats} />;
  return <LegacySaleBar token={token} stats={stats} />;
}
