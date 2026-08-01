"use client";

import { useCallback, useEffect, useState } from "react";

/** localStorage key holding the reader's choice, if they have made one. */
const DENSITY_KEY = "folio_trade_compact";

/**
 * How much of the trade panel to draw: the essentials, or everything.
 *
 * Compact keeps what a trade needs — the amount, the quick sizes, the button
 * and one line quoting the result — and folds the settings and the curve's
 * accounting behind "Details". Nothing is hidden silently: the slippage in
 * force is printed in the line that stays.
 *
 * The point is the phone, where the panel is most of a screen and every line it
 * grows is another one to scroll past on the way to the button. So an unanswered
 * question is answered by the screen: compact where the panel fills the window,
 * full where the whole of it is in view at once. A reader who answers it
 * themselves is remembered, on every token page, until they change their mind.
 *
 * Both reads happen in an effect. localStorage and matchMedia are client-only,
 * and a first render that disagreed with the server's would be a hydration
 * mismatch — so the server and the first client paint agree on `false`, and the
 * real answer arrives a frame later.
 */
export function useTradeDensity(): {
  compact: boolean;
  setCompact: (compact: boolean) => void;
} {
  const [compact, setState] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(DENSITY_KEY);
    } catch {
      // Storage unavailable — Safari private mode, storage disabled by policy.
      // The screen still gets to answer.
    }

    if (stored === "1" || stored === "0") {
      setState(stored === "1");
      return;
    }

    // Below 64rem the panel is close to a screenful on its own; above it the
    // whole panel and the figures over it are in view together.
    setState(
      typeof window.matchMedia === "function" && window.matchMedia("(max-width: 63.99rem)").matches
    );
  }, []);

  const setCompact = useCallback((next: boolean) => {
    setState(next);
    try {
      window.localStorage.setItem(DENSITY_KEY, next ? "1" : "0");
    } catch {
      // The choice still holds for this page view; it just will not survive a
      // reload, which is the harmless way to fail.
    }
  }, []);

  return { compact, setCompact };
}
