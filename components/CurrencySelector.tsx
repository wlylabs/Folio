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
 * Absent until a rate arrives. A currency switch with nothing to convert is a
 * control that does nothing, and while the price feed is down that is exactly
 * what it would be.
 */
export default function CurrencySelector() {
  const { currency, setCurrency, rate } = useCurrency();
  if (rate === null) return null;

  return (
    <div className="currency-toggle" role="group" aria-label="Display currency">
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
  );
}
