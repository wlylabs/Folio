"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PriceChart from "@/components/PriceChart";
import FiatValue from "@/components/FiatValue";
import { explorerTxUrl } from "@/lib/chains";
import { TRADE_SETTLED_EVENT } from "@/lib/tradeEvents";
import {
  availableRanges,
  DEFAULT_RANGE,
  formatMove,
  moveArrow,
  priceMove,
  rangeByKey,
  windowTrades,
  type RangeKey,
} from "@/lib/priceWindow";
import type { Trade, TradeHistory } from "@/lib/tradeHistory";
import {
  formatEth,
  formatEthPrice,
  formatRelativeTime,
  formatTokens,
  shortAddress,
  type Token,
} from "@/lib/types";

/**
 * A launch's price history and its trade tape.
 *
 * The curve's whole history is already on chain — every `TokensBought` and
 * `TokensSold` carries the price it left behind — so this reads it back rather
 * than recording anything. Nothing here is stored, which means nothing here can
 * disagree with the contract.
 *
 * It loads after the page rather than with it. The scan behind
 * `/api/token/<address>/trades` is a dozen log queries and a block header per
 * trade; the article, the fact box and the trade panel are the page and none of
 * them should wait on it. So this mounts empty, says it is reading the log, and
 * fills in.
 *
 * It refreshes on a timer, and immediately when a trade settles in the panel
 * below — see lib/tradeEvents.ts for why that is a window event rather than
 * shared state.
 *
 * The panel reads top to bottom the way a quote does anywhere else: the price,
 * what it has done over the selected window, the chart of that window, the
 * windows on offer, then the trades themselves. Everything above the tape is
 * one figure and its context, which is what a reader who scrolled down here
 * came for; the tape is the evidence for it.
 */

/** How often the history is re-read while the page is open, in ms. */
const REFRESH_MS = 30_000;

/** Rows in the tape. The chart plots the whole window; the list is a summary. */
const TAPE_ROWS = 8;

export default function TradeHistoryPanel({ token }: { token: Token }) {
  const [history, setHistory] = useState<TradeHistory | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  /** The trade under the pointer on the chart, or null when nobody is on it. */
  const [scrubbed, setScrubbed] = useState<Trade | null>(null);

  const address = token.contract_address;
  const chain = token.chain;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(
          `/api/token/${address}/trades?chain=${encodeURIComponent(chain)}`,
          { signal, cache: "no-store" }
        );
        const body: unknown = await response.json();

        if (!response.ok) {
          const message = (body as { error?: string } | null)?.error;
          throw new Error(message || `The trade log request failed (${response.status}).`);
        }

        setHistory(body as TradeHistory);
        setFailed(null);
      } catch (err) {
        // An abort is this component unmounting or a refresh superseding an
        // in-flight read. Neither is a failure to report.
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Trade history failed to load:", err);
        setFailed(err instanceof Error ? err.message : "Could not read the trade log.");
      } finally {
        setLoading(false);
      }
    },
    [address, chain]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);

    const timer = setInterval(() => void load(), REFRESH_MS);
    // A trade the reader just made should appear without waiting out the timer.
    const onSettled = () => void load();
    window.addEventListener(TRADE_SETTLED_EVENT, onSettled);

    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener(TRADE_SETTLED_EVENT, onSettled);
    };
  }, [load]);

  const trades = useMemo(() => history?.trades ?? [], [history]);

  const ranges = useMemo(() => availableRanges(trades), [trades]);

  /**
   * The window actually drawn.
   *
   * Never trusts the state directly: a refresh can retire the chip the reader
   * pressed — the last trade inside an hour ages out of it — and a selection
   * that no longer exists falls back to the whole history rather than to an
   * empty chart.
   */
  const active = rangeByKey(ranges.some((r) => r.key === range) ? range : DEFAULT_RANGE);
  const { trades: windowed, baseline } = useMemo(
    () => windowTrades(trades, active),
    [trades, active]
  );

  // What the quote is pointed at: the trade under the pointer while the reader
  // is scrubbing the chart, and the latest one the rest of the time.
  const latest = windowed.length > 0 ? windowed[windowed.length - 1] : null;
  const shown = scrubbed ?? latest;
  const move = priceMove(baseline, shown?.price ?? null);

  const newestFirst = [...windowed].reverse();

  function chooseRange(key: RangeKey) {
    setRange(key);
    // The trade being scrubbed may not be in the new window, and a quote
    // pointed at something the chart no longer draws is worse than no quote.
    setScrubbed(null);
  }

  return (
    <section className="factbox" aria-label="Price history">
      <h2 className="factbox__head">
        <span>Price on the curve</span>
        <span>
          {windowed.length > 0
            ? `${windowed.length} trade${windowed.length === 1 ? "" : "s"}`
            : "from the log"}
        </span>
      </h2>

      {loading && trades.length === 0 && (
        <p className="factbox__row muted">Reading the trade log...</p>
      )}

      {/*
        Three ways to have no chart, and they are not the same news. A launch
        with no trades yet is healthy; a scan that failed or was cut short says
        nothing about whether trades exist, and must not be reported as "none".
      */}
      {!loading && trades.length === 0 && (failed || history?.error) && (
        <p className="factbox__row muted">
          {failed ?? "The trade log couldn't be read in full."} The curve itself is unaffected —
          this panel only reads history.
        </p>
      )}

      {!loading && !failed && !history?.error && trades.length === 0 && (
        <p className="factbox__row muted">
          No trades yet. The first buy sets the first point on this chart.
        </p>
      )}

      {shown && (
        <>
          {/*
            The quote. The label is what makes scrubbing honest: the moment the
            figure stops being the current price it stops calling itself one,
            and says when the trade under the pointer happened instead.
          */}
          <div className="quote">
            <div>
              <span className="quote__label">
                {scrubbed ? formatRelativeTime(scrubbed.timestamp) : "Price now"}
              </span>
              <span className="quote__value nums">
                {formatEthPrice(shown.price)} <span className="quote__unit">ETH</span>
              </span>
              <FiatValue eth={shown.price} block />
            </div>

            {move && (
              <p className="quote__aside">
                <span className={`move move--${move.direction}`}>
                  <span aria-hidden="true">{moveArrow(move.direction)}</span>
                  {formatMove(move)}
                </span>
                <span className="move__span">{active.span}</span>
              </p>
            )}
          </div>

          <PriceChart
            trades={windowed}
            symbol={token.symbol}
            baseline={baseline}
            spanLabel={active.key === "ALL" ? undefined : active.span}
            onSelect={setScrubbed}
          />

          {/* Only drawn when there is more than one window to choose between —
              a lone "All" chip is a control that cannot do anything. */}
          {ranges.length > 1 && (
            <div className="chart__ranges" role="group" aria-label="Chart period">
              {ranges.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className="chip"
                  aria-pressed={option.key === active.key}
                  onClick={() => chooseRange(option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}

          <ul className="tape">
            {newestFirst.slice(0, TAPE_ROWS).map((trade) => {
              const tx = explorerTxUrl(chain, trade.txHash);
              const on = scrubbed !== null && tradeKey(scrubbed) === tradeKey(trade);
              return (
                <li key={tradeKey(trade)} className={`tape__row${on ? " tape__row--on" : ""}`}>
                  {/*
                    The side is a word first. It takes the up or down colour as
                    well now, but the word is what a printout, a screen reader
                    and a reader who does not separate the two are left with —
                    same as the filled and hollow markers on the chart.
                  */}
                  <span className={`tape__side tape__side--${trade.side}`}>
                    {trade.side === "buy" ? "Buy" : "Sell"}
                  </span>

                  <span className="tape__amount">
                    {formatTokens(trade.tokens)} ${token.symbol}
                    <span className="tape__sub">
                      {formatEth(trade.eth)} ETH <FiatValue eth={trade.eth} />
                    </span>
                  </span>

                  <span className="tape__when">
                    {tx ? (
                      <a href={tx} target="_blank" rel="noopener noreferrer" className="mono">
                        {shortAddress(trade.trader)}
                      </a>
                    ) : (
                      <span className="mono">{shortAddress(trade.trader)}</span>
                    )}
                    <span className="tape__sub">{formatRelativeTime(trade.timestamp)}</span>
                  </span>
                </li>
              );
            })}
          </ul>

          <p className="field__hint" style={{ padding: "0 0.875rem var(--sp-3)" }}>
            {active.key !== "ALL"
              ? `The ${windowed.length} trade${windowed.length === 1 ? "" : "s"} in the ${
                  active.span
                }, read from the contract's own log.`
              : history?.truncated
                ? `The last ${trades.length} trades, read from the contract's own log.`
                : "Every trade this launch has had, read from the contract's own log."}
            {history?.error && " The scan was cut short, so older trades may be missing."}
          </p>
        </>
      )}
    </section>
  );
}

/** Unique per trade: a hash alone isn't, since one call can emit two. */
function tradeKey(trade: Trade): string {
  return `${trade.txHash}-${trade.logIndex}`;
}
