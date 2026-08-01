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
 * Either panel renders in the flow of the article, after the piece and before
 * the contract's own figures — the page argues its case first and offers the
 * button at the end of it. The byline carries an anchor down here for a reader
 * who already knows what they came for.
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
