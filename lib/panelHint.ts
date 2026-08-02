/**
 * How tall a panel that fills itself in was, the last time this reader saw it.
 *
 * The problem is the same shape as lib/walletHint.ts, one page further in. The
 * price panel on a listing does not arrive with the page: the scan behind
 * `/api/token/<address>/trades` is a dozen log queries and a block header per
 * trade, so the panel deliberately mounts saying it is reading the log and
 * fills in a moment later (components/TradeHistoryPanel.tsx). What fills in is
 * a quote, a chart, a row of range chips and up to eight rows of tape — several
 * hundred pixels appearing in the middle of an article, after the browser has
 * already restored the scroll position of the refresh that asked for it.
 *
 * So the height is remembered, per page, and read synchronously by the boot
 * script before the first paint. The panel opens at the size it closed at and
 * fills in without moving anything below it.
 *
 * Three things this is careful about:
 *
 *  - **It is a hint, never a claim.** Nothing reads it to decide what to
 *    render. It reserves space, and the moment the panel has real content the
 *    reservation is dropped — a launch that has since had its first trade, or
 *    lost the lot, is drawn from what the log says and not from this.
 *  - **A height is only meaningful at the width it was measured at.** A panel
 *    measured on a laptop and restored on a phone rotated into portrait would
 *    reserve the wrong space in the wrong direction, so the width is stored
 *    beside it and a mismatch means no hint at all.
 *  - **It is bounded.** One entry per path, oldest dropped past `LIMIT`, so a
 *    reader who browses a hundred listings does not carry a hundred records
 *    around forever.
 */

/** localStorage key holding every remembered panel height. */
export const PANEL_HINT_KEY = "folio_panel_hint";

/**
 * Custom property the boot script writes the remembered height onto, in px.
 * `app/globals.css` reserves with it while a panel is still loading.
 */
export const PANEL_HINT_PROPERTY = "--panel-hint";

/** Paths kept. Enough for a session of reading; small enough to stay cheap. */
const LIMIT = 24;

/**
 * Below this a reservation is not worth making: a panel this short is one line
 * of copy, and the shift it causes is smaller than the risk of holding space
 * for something that no longer renders.
 */
const MIN_HEIGHT = 80;

type PanelHint = {
  /** Rendered height in CSS pixels, rounded. */
  h: number;
  /** Viewport width it was measured at. A different one invalidates it. */
  w: number;
};

type PanelHints = Record<string, PanelHint>;

function isHint(value: unknown): value is PanelHint {
  if (typeof value !== "object" || value === null) return false;
  const { h, w } = value as Partial<PanelHint>;
  return typeof h === "number" && h > 0 && typeof w === "number" && w > 0;
}

function readAll(): PanelHints {
  try {
    const raw = window.localStorage.getItem(PANEL_HINT_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};

    const hints: PanelHints = {};
    for (const [path, hint] of Object.entries(parsed)) {
      if (isHint(hint)) hints[path] = hint;
    }
    return hints;
  } catch {
    // Storage unavailable, or something else wrote nonsense to the key. Either
    // way the page works; it just lays the panel out twice.
    return {};
  }
}

/**
 * Remember what the panel measured, for the next load of this same page.
 *
 * Called from a ResizeObserver rather than once after loading, because the
 * height keeps settling for a moment after the trades land: the fiat line under
 * the quote appears when the rate arrives, and a poll thirty seconds later can
 * add a row. The last measurement is the one worth keeping.
 */
export function rememberPanelHeight(path: string, height: number, width: number): void {
  const h = Math.round(height);
  if (!Number.isFinite(h) || h < MIN_HEIGHT || !Number.isFinite(width) || width <= 0) return;

  try {
    const hints = readAll();
    const previous = hints[path];
    // A pixel or two either way is the same panel. Writing on every observation
    // would touch storage on every scroll-driven reflow for no gain.
    if (previous && previous.w === width && Math.abs(previous.h - h) < 8) return;

    delete hints[path];
    const entries = Object.entries(hints);
    // Object key order is insertion order for string keys, so the oldest
    // records are simply the ones at the front.
    const kept = entries.slice(Math.max(0, entries.length - (LIMIT - 1)));
    kept.push([path, { h, w: width }]);

    window.localStorage.setItem(PANEL_HINT_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // See readAll: a page that cannot remember this is a page that jumps once.
  }
}
