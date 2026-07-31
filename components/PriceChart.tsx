"use client";

import { useMemo, useState } from "react";
import type { Trade } from "@/lib/tradeHistory";
import { formatEthPrice, formatRelativeTime, formatTokens } from "@/lib/types";

/**
 * The price a launch's curve has actually held, drawn from its own event log.
 *
 * Four decisions carry this chart:
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
 * prices on testnet live in the sixth decimal place; a zero baseline flattens
 * every one of them into the same line. The high and the low are printed
 * instead, to enough significant figures to tell them apart — which the site's
 * usual six-decimal ETH format cannot do down here.
 *
 * One series, so there is no legend — the panel heading names the line — and no
 * palette to choose: ink on paper, with buy and sell carried by filled and
 * hollow markers and repeated as words in the tape below, never by colour.
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
  onSelect,
}: {
  /** Oldest first. */
  trades: Trade[];
  symbol: string;
  /** Called with the hovered trade, so a caller can highlight it in the tape. */
  onSelect?: (trade: Trade | null) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => buildModel(trades), [trades]);

  if (!model) return null;

  const { points, low, high, yHigh, yLow, xLabels } = model;
  const active = hover === null ? null : points[hover];
  const last = points[points.length - 1];

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
    <div className="chart">
      {/*
        The y-axis, written out. Three numbers say what a labelled axis would,
        and stay legible at any width.
      */}
      <dl className="chart__scale">
        <div>
          <dt>High</dt>
          <dd>{formatEthPrice(high)}</dd>
        </div>
        <div>
          <dt>Low</dt>
          <dd>{formatEthPrice(low)}</dd>
        </div>
        <div>
          <dt>Now</dt>
          <dd>{formatEthPrice(last.trade.price)} ETH</dd>
        </div>
      </dl>

      <div className="chart__plot">
        <svg className="chart__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary(trades, symbol)}>
          <title>{`$${symbol} price on the curve`}</title>
          <desc>{summary(trades, symbol)}</desc>

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

          {/* A wash, not a block: it reads as "under the line". */}
          <path d={areaPath(points)} fill="var(--ink)" opacity={0.06} />

          <path
            d={linePath(points)}
            fill="none"
            stroke="var(--ink)"
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
              fill={p.trade.side === "buy" ? "var(--ink)" : "var(--paper-raised)"}
              stroke="var(--ink)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ))}

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
            <b>{active.trade.side === "buy" ? "Bought" : "Sold"}</b>{" "}
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
 */
function buildModel(trades: Trade[]) {
  if (trades.length === 0) return null;

  const prices = trades.map((t) => t.price);
  if (prices.some((p) => !Number.isFinite(p))) return null;

  const low = Math.min(...prices);
  const high = Math.max(...prices);

  // A launch whose price never moved still deserves a line rather than a
  // divide-by-zero, so a flat history gets a band around its one price.
  const pad = high > low ? (high - low) * 0.15 : Math.max(high * 0.15, Number.MIN_VALUE);
  const yMin = low - pad;
  const ySpan = high + pad - yMin || 1;
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

  return { points, low, high, yHigh: toY(high), yLow: toY(low), xLabels };
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
function summary(trades: Trade[], symbol: string): string {
  const first = trades[0];
  const last = trades[trades.length - 1];
  const move = first.price > 0 ? ((last.price - first.price) / first.price) * 100 : 0;

  return (
    `$${symbol} price across the last ${trades.length} trade${trades.length === 1 ? "" : "s"}: ` +
    `${formatEthPrice(first.price)} ETH to ${formatEthPrice(last.price)} ETH, ` +
    `${move >= 0 ? "up" : "down"} ${Math.abs(move).toFixed(1)}%. ` +
    `Every trade is listed below the chart.`
  );
}
