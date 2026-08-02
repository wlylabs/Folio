"use client";

import { useCurrency } from "@/components/CurrencyProvider";

/**
 * What an ETH figure is worth in the reader's chosen currency.
 *
 * Sits beside a price, never instead of one: the ETH amount is what the
 * contract charges and this is an estimate of it in money, which is why it is
 * marked "≈" and set quieter than the figure it follows.
 *
 * Renders nothing at all when there is no rate — the first paint of every page,
 * and every page load while the price feed is down. The `≈ $0.00` that a
 * missing rate would otherwise produce would read as "this is free", so the
 * line is dropped instead and the ETH stands on its own.
 *
 * Nothing, in the stacked case, still leaves its line behind. A conversion set
 * under a figure is a whole line of the layout, and it arrives a beat after the
 * page does; without the blank the fact table it sits in grows by one line per
 * figure while the reader is already reading it. The blank is inert to
 * assistive technology and says nothing on screen — the space is held, no
 * estimate is claimed.
 */
export default function FiatValue({
  eth,
  block = false,
  parens = false,
}: {
  eth: number | null | undefined;
  /** Put the conversion on its own line, for stacked figures in a fact table. */
  block?: boolean;
  /**
   * Bracket it, for running text that already carries an "≈" of its own — a
   * quoted payout is approximate twice over and should only say so once.
   */
  parens?: boolean;
}) {
  const { toFiat } = useCurrency();
  const amount = toFiat(eth);

  if (amount === null) {
    if (!block) return null;
    return (
      <span className="fiat fiat--block fiat--held" aria-hidden="true">
        &nbsp;
      </span>
    );
  }

  return (
    <span className={`fiat${block ? " fiat--block" : ""}`}>
      {parens ? `(≈ ${amount})` : `≈ ${amount}`}
    </span>
  );
}
