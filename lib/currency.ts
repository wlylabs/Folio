/**
 * Display currency: what the ETH figures on this site are *also* worth.
 *
 * Everything Folio prices is priced in ETH by a contract, and that stays true —
 * nothing in this module is ever used to compute a trade, a floor or a stored
 * value. It exists because "0.0002 ETH" is not a number most readers can feel,
 * and a second line saying "≈ $0.53" costs nothing and answers the question
 * they were going to ask anyway.
 *
 * The rate comes from /api/eth-price, which caches CoinGecko server-side. This
 * file is the vocabulary around it: which currencies exist, how each one is
 * written, and where the reader's choice is remembered.
 */

export type CurrencyCode = "USD" | "IDR";

/** localStorage key holding the reader's choice. */
export const CURRENCY_KEY = "folio_currency_pref";

/** Fired on the window when the choice changes, so other trees follow along. */
export const CURRENCY_EVENT = "folio:currency";

export const DEFAULT_CURRENCY: CurrencyCode = "USD";

type CurrencySpec = {
  code: CurrencyCode;
  /** What the selector prints. */
  label: string;
  /** The locale whose conventions the amount is written in. */
  locale: string;
  /**
   * Decimal places at ordinary sizes. IDR is quoted in whole rupiah — a
   * fractional one has not bought anything in decades — and USD in cents.
   */
  digits: number;
  /**
   * Decimal places for amounts below one unit. Testnet curves price a single
   * token in the 1e-9 ETH range, which is a fraction of a cent and a fraction
   * of a rupiah; rounding those to "$0.00" would print a lie where a small
   * number belongs.
   */
  smallDigits: number;
};

export const CURRENCIES: readonly CurrencySpec[] = [
  { code: "USD", label: "USD", locale: "en-US", digits: 2, smallDigits: 6 },
  { code: "IDR", label: "IDR", locale: "id-ID", digits: 0, smallDigits: 4 },
] as const;

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return CURRENCIES.some((c) => c.code === value);
}

function specFor(code: CurrencyCode): CurrencySpec {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

/**
 * The stored choice, or null if this reader has not made one.
 *
 * Null on the server and in any browser where localStorage throws — Safari in
 * private mode, storage disabled by policy — which the caller reads as "use the
 * default", never as an error.
 */
export function readCurrency(): CurrencyCode | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(CURRENCY_KEY);
    return isCurrencyCode(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Remember a choice and tell the rest of the page about it. */
export function writeCurrency(code: CurrencyCode): void {
  try {
    window.localStorage.setItem(CURRENCY_KEY, code);
  } catch {
    // Storage unavailable. The choice still applies to this page view; it just
    // will not survive a reload, which is the harmless way to fail.
  }

  window.dispatchEvent(new CustomEvent(CURRENCY_EVENT, { detail: code }));
}

/**
 * The currency to open on for a reader who has never chosen.
 *
 * A guess from the browser's own locale, and only a guess: an Indonesian
 * browser gets IDR, everyone else gets USD. The selector is one click either
 * way and the answer is remembered, so being wrong here costs a reader one
 * click, once.
 */
export function preferredCurrency(): CurrencyCode {
  if (typeof navigator === "undefined") return DEFAULT_CURRENCY;

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  const indonesian = languages.some((tag) => typeof tag === "string" && /^id\b|-ID$/i.test(tag));

  return indonesian ? "IDR" : DEFAULT_CURRENCY;
}

/**
 * An amount of money, written the way its own locale writes it.
 *
 * `Intl.NumberFormat` rather than a hand-rolled symbol and separator, so USD
 * comes out "$1,234.56" and IDR "Rp 1.234" without this file having opinions
 * about where the dots go.
 *
 * Returns null for anything that isn't a finite number, because the caller's
 * job in that case is to print nothing at all rather than a zero.
 */
export function formatFiat(value: number | null | undefined, code: CurrencyCode): string | null {
  if (value === null || value === undefined) return null;

  const n = Number(value);
  if (!Number.isFinite(n)) return null;

  const spec = specFor(code);
  const magnitude = Math.abs(n);

  // Sub-unit amounts get the longer tail; everything else gets the currency's
  // ordinary two-or-zero.
  const maximumFractionDigits = magnitude > 0 && magnitude < 1 ? spec.smallDigits : spec.digits;
  const minimumFractionDigits = Math.min(spec.digits, maximumFractionDigits);

  const format = new Intl.NumberFormat(spec.locale, {
    style: "currency",
    currency: spec.code,
    minimumFractionDigits,
    maximumFractionDigits,
  });

  // Below the last decimal place there is nothing left to print but zero, and
  // "$0.00" for a real amount reads as free. Say "smaller than this" instead.
  const floor = Math.pow(10, -maximumFractionDigits);
  if (magnitude > 0 && magnitude < floor) {
    return `${n < 0 ? ">-" : "<"}${format.format(n < 0 ? -floor : floor)}`;
  }

  return format.format(n);
}

/** The rates /api/eth-price serves: fiat per one ETH, one entry per currency. */
export type EthRates = Record<CurrencyCode, number>;

/** A rates payload as it arrives over the wire, before it is trusted. */
export function parseRates(value: unknown): EthRates | null {
  if (typeof value !== "object" || value === null) return null;

  const rates: Partial<EthRates> = {};
  for (const { code } of CURRENCIES) {
    const rate = (value as Record<string, unknown>)[code.toLowerCase()];
    // A zero or negative rate is a broken feed, not a cheap ETH.
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
    rates[code] = rate;
  }

  return rates as EthRates;
}
