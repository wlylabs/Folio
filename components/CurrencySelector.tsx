"use client";

import { useCurrency } from "@/components/CurrencyProvider";
import { CURRENCIES } from "@/lib/currency";

/**
 * Which currency the conversions on the page are written in.
 *
 * Two buttons rather than a dropdown: there are two options, and a select
 * element for two options is a click and a menu to say what a pair of toggles
 * says at a glance. The choice is remembered in localStorage, so it holds
 * between visits, and every figure on the page follows it immediately — the
 * rate for both currencies is already in hand, so switching costs no request.
 *
 * It lives in the settings panel, beside the wallet, rather than loose in the
 * masthead: it governs every conversion on the site, not the nearest price.
 * That is also why it stays visible when the price feed is down — a preference
 * a reader can set today and see honoured tomorrow is worth showing even while
 * there is no rate to convert with. The note says as much rather than leaving a
 * toggle that appears to do nothing.
 */
export default function CurrencySelector() {
  const { currency, setCurrency, rate } = useCurrency();

  return (
    <>
      <div className="chip-row" role="group" aria-label="Display currency">
        {CURRENCIES.map(({ code, label }) => (
          <button
            key={code}
            type="button"
            className="chip"
            aria-pressed={currency === code}
            onClick={() => setCurrency(code)}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="settings__note">
        {rate === null
          ? "The price feed is unreachable, so figures stay in ETH alone. This choice applies as soon as a rate arrives."
          : "Every ETH figure on the site carries a second line in this currency. Prices are still quoted and settled in ETH."}
      </p>
    </>
  );
}
