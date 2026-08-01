/**
 * The window a price history is read over, and what the price did across it.
 *
 * Two things a chart of a traded asset is expected to answer before anything
 * else: over what period, and up or down. Folio's chart answered neither — it
 * drew every trade the scan found and left the reader to compare the left edge
 * with the right one by eye. This module is the vocabulary for both.
 *
 * The baseline is the part worth being careful about. A window's opening price
 * is not the first trade *inside* it — it is the price the curve was already
 * holding when the window began, which is the last trade *before* it. Taking
 * the first trade inside would quietly discount the move that trade itself
 * made, and on a curve where a single buy can move the price by a fifth, that
 * is not a rounding difference. When there is nothing before the window — the
 * whole history, or a launch younger than the range — the first trade in it is
 * the honest baseline, and there is no earlier price to claim otherwise.
 */

import type { Trade } from "@/lib/tradeHistory";

export type RangeKey = "1H" | "1D" | "1W" | "1M" | "ALL";

export type Range = {
  key: RangeKey;
  /** What the chip says. */
  label: string;
  /** How far back the window reaches, in seconds. Null is the whole history. */
  seconds: number | null;
  /** How the change beside the price names the period. */
  span: string;
};

export const RANGES: readonly Range[] = [
  { key: "1H", label: "1H", seconds: 3_600, span: "past hour" },
  { key: "1D", label: "1D", seconds: 86_400, span: "past day" },
  { key: "1W", label: "1W", seconds: 7 * 86_400, span: "past week" },
  { key: "1M", label: "1M", seconds: 30 * 86_400, span: "past month" },
  { key: "ALL", label: "All", seconds: null, span: "all time" },
] as const;

export const DEFAULT_RANGE: RangeKey = "ALL";

export function rangeByKey(key: RangeKey): Range {
  return RANGES.find((r) => r.key === key) ?? RANGES[RANGES.length - 1];
}

/**
 * The ranges worth offering for a given history.
 *
 * A range earns its chip by being a different picture from the one beside it:
 * it has to contain a trade, so there is something to draw, and it has to leave
 * one out, so it is not just "All" wearing a shorter name. Every other filter
 * is a control that appears broken when pressed.
 *
 * A history with no block timestamps gets nothing but "All" — without a clock
 * there is no window to cut, and the chart says as much by spacing trades
 * evenly instead of by time.
 */
export function availableRanges(trades: Trade[], now = Date.now() / 1000): Range[] {
  const stamps = trades.map((t) => t.timestamp);
  const timed = stamps.every((s): s is number => typeof s === "number" && Number.isFinite(s));

  const all = RANGES[RANGES.length - 1];
  if (!timed || trades.length < 2) return [all];

  const offered = RANGES.filter((range) => {
    if (range.seconds === null) return false;
    const cut = now - range.seconds;
    return stamps.some((s) => s >= cut) && stamps.some((s) => s < cut);
  });

  return [...offered, all];
}

export type PriceWindow = {
  /** The trades inside the window, oldest first. */
  trades: Trade[];
  /** The price the window opened at — see the note at the top of this file. */
  baseline: number | null;
};

/** Cut a history down to one range. */
export function windowTrades(
  trades: Trade[],
  range: Range,
  now = Date.now() / 1000
): PriceWindow {
  if (range.seconds === null || trades.length === 0) {
    return { trades, baseline: trades[0]?.price ?? null };
  }

  const cut = now - range.seconds;
  const start = trades.findIndex(
    (t) => typeof t.timestamp === "number" && Number.isFinite(t.timestamp) && t.timestamp >= cut
  );

  // Nothing inside the window: the range should not have been offered, but a
  // refresh can age the last trade out from under a chip the reader already
  // pressed. The whole history is the honest thing to draw rather than an
  // empty panel.
  if (start === -1) return { trades, baseline: trades[0]?.price ?? null };

  const inside = trades.slice(start);
  const before = start > 0 ? trades[start - 1].price : null;

  return { trades: inside, baseline: before ?? inside[0]?.price ?? null };
}

export type MoveDirection = "up" | "down" | "flat";

export type PriceMove = {
  direction: MoveDirection;
  /** Signed, in percent. */
  percent: number;
  from: number;
  to: number;
};

/**
 * What the price did between two figures.
 *
 * Null rather than zero when there is nothing to compare against: a launch
 * with one trade has a price and no move, and printing "0.0%" for that would be
 * a claim about a period that never elapsed.
 *
 * "Flat" is anything that rounds to nothing at the one decimal place the chip
 * prints. A curve that moved in the eighth decimal did move, and saying so with
 * a green arrow beside "0.0%" would look like a bug.
 */
export function priceMove(from: number | null, to: number | null): PriceMove | null {
  if (from === null || to === null) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;

  const percent = ((to - from) / from) * 100;
  const direction: MoveDirection =
    Math.abs(percent) < 0.05 ? "flat" : percent > 0 ? "up" : "down";

  return { direction, percent, from, to };
}

/** The arrow. Aria-hidden wherever it is drawn — the word below carries it. */
export function moveArrow(direction: MoveDirection): string {
  return direction === "up" ? "▲" : direction === "down" ? "▼" : "—";
}

/**
 * The change, in words and a figure: "Up 12.4%", "Down 3.1%", "Unchanged".
 *
 * The word is not decoration. It is what a screen reader reads, what survives
 * a printout, and what a reader who does not separate red from green is left
 * with — so the colour beside it is never carrying the fact on its own.
 */
export function formatMove(move: PriceMove): string {
  if (move.direction === "flat") return "Unchanged";
  const word = move.direction === "up" ? "Up" : "Down";
  return `${word} ${Math.abs(move.percent).toFixed(1)}%`;
}
