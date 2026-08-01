"use client";

import { useMemo, useState } from "react";
import type { Trade } from "@/lib/tradeHistory";
import { priceMove, type MoveDirection } from "@/lib/priceWindow";
import { formatEthPrice, formatRelativeTime, formatTokens } from "@/lib/types";

/**
 * The price a launch's curve has actually held, drawn from its own event log.
 *
 * Five decisions carry this chart:
 *
 * **It steps, it does not slope.** A constant-product curve only moves when
 * somebody trades against it. Between two trades the marginal price is a flat
 * line, so that is what gets drawn — sloping between points would invent a
 * continuous drift that never happened, which is exactly the impression a price
 * chart is most likely to leave.
 *
 * **The last price runs to the right edge.** The final trade's price is still
 * the price now, so the step extends to the present rather than stopping at
 * whenever the last trade landed. A launch that hasn't traded in a day should
 * look like a flat day, not like a chart that ends early.
 *
 * **The scale is HTML, not SVG text.** The plot scales to its container, and
 * anything drawn inside it scales too — which turns a 9px axis label into a 5px
 * one on a phone. So the SVG holds marks and nothing else, and the numbers sit
 * around it in real text at a real size.
 *
 * **The axis is never zero-based, and says so by naming its ends.** Curve
 * prices open in the sixth decimal place; a zero baseline flattens
 * every one of them into the same line. The high and the low are printed
 * instead, to enough significant figures to tell them apart — which the site's
 * usual six-decimal ETH format cannot do down here.
 *
 * **The line is coloured by the window, and by nothing else.** Green if the
 * price ended the selected range above the dashed line it opened at, red if
 * below — the one convention worth borrowing from a broker, because it answers
 * at a glance the question the reader came with. Buy and sell keep their filled
 * and hollow markers and their words in the tape below: side and direction are
 * two different facts, and neither one is ever left to a colour alone.
 */

/** The drawing surface, in user units. The SVG scales; these do not. */
const W = 560;
const H = 170;

/** Inset so a marker sitting on the high or the low isn't clipped in half. */
const INSET = 8;

const PLOT_W = W - INSET * 2;
const PLOT_H = H - INSET * 2;

export default function PriceChart({
  trades,
  symbol,
  baseline,
  spanLabel,
  onSelect,
}: {
  /** Oldest first, already cut to the selected window. */
  trades: Trade[];
  symbol: string;
  /** The price the window opened at, drawn as the line the move is measured
   *  from. Null when there is nothing to measure against. */
  baseline?: number | null;
  /** How the window names itself in the alternative text — "past day". */
  spanLabel?: string;
  /** Called with the hovered trade, so a caller can highlight it in the tape
   *  and re-point the quote above the chart at it. */
  onSelect?: (trade: Trade | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const open = baseline ?? null;
  const model = useMemo(() => buildModel(trades, open), [trades, open]);

  if (!model) return null;

  const { points, low, high, yHigh, yLow, yOpen, xLabels } = model;
  const active = hover === null ? null : points[hover];
  const last = points[points.length - 1];

  // The window's direction, which is the only thing that colours anything here.
  const move = priceMove(open, last.trade.price);
  const direction: MoveDirection = move?.direction ?? "flat";

  function moveTo(index: number | null) {
    setHover(index);
    onSelect?.(index === null ? null : trades[index]);
  }

  /** The nearest point to where the pointer is, in user units. */
  function onPointer(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;

    const x = ((event.clientX - box.left) / box.width) * W;

    let nearest = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (Math.abs(points[i].x - x) < Math.abs(points[nearest].x - x)) nearest = i;
    }
    moveTo(nearest);
  }

  return (
    <div
      className={`chart${direction === "flat" ? "" : ` chart--${direction}`}`}
    >
      {/*
        The y-axis, written out. Three numbers say what a labelled axis would,
        and stay legible at any width. "Open" is the dashed line in the plot —
        printed rather than labelled inside the SVG, for the same reason as the
        rest of this row.
      */}
      <dl className="chart__scale">
        {open !== null && (
          <div>
            <dt>Open</dt>
            <dd>{formatEthPrice(open)}</dd>
          </div>
        )}
        <div>
          <dt>High</dt>
          <dd>{formatEthPrice(high)}</dd>
        </div>
        <div>
          <dt>Low</dt>
          <dd>{formatEthPrice(low)}</dd>
        </div>
      </dl>

      <div className="chart__plot">
        <svg
          className="chart__svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={summary(trades, symbol, open, spanLabel)}
        >
          <title>{`$${symbol} price on the curve`}</title>
          <desc>{summary(trades, symbol, open, spanLabel)}</desc>

          {/*
            Two solid hairlines at the high and the low — the values printed
            above — and one at the midpoint. Never dashed: dashing reads as a
            threshold, and these are just a grid.
          */}
          {[yHigh, (yHigh + yLow) / 2, yLow].map((y, i) => (
            <line
              key={i}
              x1={INSET}
              x2={W - INSET}
              y1={y}
              y2={y}
              stroke="var(--rule)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/*
            The opening price, and the one line here that *is* a threshold, so
            it is the one that gets dashed: everything drawn above it is a gain
            over the window and everything below it a loss. The y-domain always
            includes it, so it cannot fall off the top or bottom of its own
            chart.
          */}
          {yOpen !== null && (
            <line
              x1={INSET}
              x2={W - INSET}
              y1={yOpen}
              y2={yOpen}
              stroke="var(--rule-strong)"
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* A wash, not a block: it reads as "under the line". */}
          <path d={areaPath(points)} fill="var(--series)" opacity={0.08} />

          <path
            d={linePath(points)}
            fill="none"
            stroke="var(--series)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Where each trade landed. Filled for a buy, hollow for a sell; the
              ring in the surface colour keeps two trades in one block from
              merging into a single blob. */}
          {points.map((p, i) => (
            <circle
              key={`${p.trade.txHash}-${p.trade.logIndex}`}
              cx={p.x}
              cy={p.y}
              r={hover === i ? 5 : 3.5}
              fill={p.trade.side === "buy" ? "var(--series)" : "var(--paper-raised)"}
              stroke="var(--series)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/*
            The price now, at the right edge where the last step runs out. It is
            the one mark on this chart that is not history — nothing has traded
            since, so this is what the curve is quoting at this second — and the
            slow pulse is the whole of how it says so. Reduced motion stops it
            and leaves the dot drawn.
          */}
          <circle className="chart__live" cx={W - INSET} cy={last.y} r={4} fill="var(--series)" />
          <circle cx={W - INSET} cy={last.y} r={2.5} fill="var(--series)" />

          {/* Crosshair. Vertical only — a horizontal one on a stepped line
              points at a price the tooltip already spells out. */}
          {active && (
            <line
              x1={active.x}
              x2={active.x}
              y1={INSET}
              y2={H - INSET}
              stroke="var(--rule-strong)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* The hit area, over everything and bigger than any mark. */}
          <rect
            x={0}
            y={0}
            width={W}
            height={H}
            fill="transparent"
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={() => moveTo(null)}
          />
        </svg>

        {active && (
          <div
            className="chart__tip"
            style={{
              left: `${(active.x / W) * 100}%`,
              // Flip to the other side of the crosshair past halfway, so the
              // tooltip never hangs off the panel.
              transform: `translateX(${active.x > W / 2 ? "-100%" : "0"})`,
            }}
            role="status"
          >
            <b className={`tip__side--${active.trade.side}`}>
              {active.trade.side === "buy" ? "Bought" : "Sold"}
            </b>{" "}
            {formatTokens(active.trade.tokens)} ${symbol}
            <br />
            {formatEthPrice(active.trade.eth)} ETH · {formatEthPrice(active.trade.price)} each
            <br />
            <span className="muted">{formatRelativeTime(active.trade.timestamp)}</span>
          </div>
        )}
      </div>

      <p className="chart__span">
        <span>{xLabels[0]}</span>
        <span>{xLabels[1]}</span>
      </p>
    </div>
  );
}

type Point = { x: number; y: number; trade: Trade };

/**
 * Trades to screen coordinates.
 *
 * The x-axis is time when every trade has a timestamp; otherwise it falls back
 * to even spacing by trade, which is visibly approximate. Inventing a timestamp
 * for a block whose header didn't load would not be.
 *
 * The opening price joins the y-domain even when no trade reached it, because
 * it is the line the whole chart is read against: a window that only ever
 * traded below its open must still show the open, or the reader is looking at a
 * loss with nothing on screen saying so.
 */
function buildModel(trades: Trade[], open: number | null) {
  if (trades.length === 0) return null;

  const prices = trades.map((t) => t.price);
  if (prices.some((p) => !Number.isFinite(p))) return null;

  const usableOpen = open !== null && Number.isFinite(open) && open > 0 ? open : null;
  const domain = usableOpen === null ? prices : [...prices, usableOpen];

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const yFloor = Math.min(...domain);
  const yCeiling = Math.max(...domain);

  // A launch whose price never moved still deserves a line rather than a
  // divide-by-zero, so a flat history gets a band around its one price.
  const pad =
    yCeiling > yFloor ? (yCeiling - yFloor) * 0.15 : Math.max(yCeiling * 0.15, Number.MIN_VALUE);
  const yMin = yFloor - pad;
  const ySpan = yCeiling + pad - yMin || 1;
  const toY = (price: number) => INSET + PLOT_H - ((price - yMin) / ySpan) * PLOT_H;

  const stamps = trades.map((t) => t.timestamp);
  const timed = stamps.every((s): s is number => typeof s === "number" && Number.isFinite(s));

  // The right edge is *now*, not the last trade: the price the last trade left
  // behind is still the price, and the gap since is part of the story.
  const now = Math.floor(Date.now() / 1000);
  const tStart = timed ? Math.min(...(stamps as number[])) : 0;
  const tEnd = timed ? Math.max(now, ...(stamps as number[])) : trades.length - 1;
  const tSpan = tEnd - tStart || 1;
  const lastIndex = Math.max(1, trades.length - 1);

  const points: Point[] = trades.map((trade, i) => ({
    x:
      INSET +
      (timed ? ((trade.timestamp as number) - tStart) / tSpan : i / lastIndex) * PLOT_W,
    y: toY(trade.price),
    trade,
  }));

  const xLabels: [string, string] = timed
    ? [formatRelativeTime(tStart), "now"]
    : [`${trades.length} trades back`, "latest"];

  return {
    points,
    low,
    high,
    yHigh: toY(high),
    yLow: toY(low),
    yOpen: usableOpen === null ? null : toY(usableOpen),
    xLabels,
  };
}

/**
 * The step. Horizontal to the next trade's moment at the old price, then
 * vertical to the new one — the shape the curve actually traced.
 */
function linePath(points: Point[]): string {
  const parts = [`M ${points[0].x} ${points[0].y}`];

  for (let i = 1; i < points.length; i += 1) {
    parts.push(`L ${points[i].x} ${points[i - 1].y}`, `L ${points[i].x} ${points[i].y}`);
  }

  // Out to the present at the last settled price.
  parts.push(`L ${W - INSET} ${points[points.length - 1].y}`);
  return parts.join(" ");
}

function areaPath(points: Point[]): string {
  const base = H - INSET;
  return `${linePath(points)} L ${W - INSET} ${base} L ${points[0].x} ${base} Z`;
}

/** What a screen reader is told the picture shows. */
function summary(
  trades: Trade[],
  symbol: string,
  open: number | null,
  spanLabel?: string
): string {
  const first = trades[0];
  const last = trades[trades.length - 1];
  const from = open ?? first.price;
  const move = priceMove(from, last.price);
  const period = spanLabel ? `over the ${spanLabel}` : `across the last ${trades.length} trades`;

  const shape = move
    ? move.direction === "flat"
      ? "unchanged"
      : `${move.direction} ${Math.abs(move.percent).toFixed(1)}%`
    : "with nothing to compare against";

  return (
    `$${symbol} price ${period}, over ${trades.length} trade${trades.length === 1 ? "" : "s"}: ` +
    `${formatEthPrice(from)} ETH to ${formatEthPrice(last.price)} ETH, ${shape}. ` +
    `Every trade is listed below the chart.`
  );
}
