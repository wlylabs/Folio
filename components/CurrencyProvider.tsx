"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CURRENCY_EVENT,
  CURRENCY_KEY,
  DEFAULT_CURRENCY,
  formatFiat,
  isCurrencyCode,
  parseRates,
  preferredCurrency,
  readCachedRates,
  readCurrency,
  writeCachedRates,
  writeCurrency,
  type CurrencyCode,
  type EthRates,
} from "@/lib/currency";

/**
 * How often the ETH price is re-read while a reader is on the page. The route
 * behind it caches for the same minute, so this is a cheap request that mostly
 * returns the copy the server already had.
 */
const REFRESH_MS = 60_000;

type CurrencyContextValue = {
  /** The currency every conversion on the page is currently written in. */
  currency: CurrencyCode;
  setCurrency: (code: CurrencyCode) => void;
  /** Units of `currency` per one ETH, or null while unknown or unavailable. */
  rate: number | null;
  /** An ETH amount as money, or null when there is no rate to convert with. */
  toFiat: (eth: number | null | undefined) => string | null;
};

/**
 * The fallback is a working, silent one: no rate, so `toFiat` returns null and
 * every conversion renders nothing. A tree mounted without the provider loses
 * the estimate and keeps the ETH, which is the same way this behaves when
 * CoinGecko is down.
 */
const CurrencyContext = createContext<CurrencyContextValue>({
  currency: DEFAULT_CURRENCY,
  setCurrency: () => {},
  rate: null,
  toFiat: () => null,
});

export function useCurrency(): CurrencyContextValue {
  return useContext(CurrencyContext);
}

async function fetchRates(): Promise<EthRates> {
  const response = await fetch("/api/eth-price", { cache: "no-store" });
  if (!response.ok) throw new Error(`Price endpoint answered ${response.status}`);

  const rates = parseRates(await response.json());
  if (!rates) throw new Error("Price endpoint returned no usable rates");

  return rates;
}

/**
 * Fiat conversion for every ETH figure on the site.
 *
 * Two things live here: which currency the reader chose, and what one ETH is
 * worth in it. Both are read once for the whole tree — a hundred `<FiatValue>`
 * on a page share one rate and one poll — and both can be absent, which is the
 * normal state for the first moment of every page load and the permanent state
 * when the price feed is unreachable. Nothing here ever renders a zero or an
 * error in place of a price it doesn't have; it renders nothing, and the ETH
 * figure beside it carries on alone.
 */
export default function CurrencyProvider({ children }: { children: React.ReactNode }) {
  // Starts on the default rather than on the stored choice: the server has no
  // localStorage, and rendering IDR here while the server rendered USD is a
  // hydration mismatch. The effect below corrects it on the first client pass,
  // before any rate has arrived to convert with.
  const [currency, setCurrencyState] = useState<CurrencyCode>(DEFAULT_CURRENCY);

  useEffect(() => {
    setCurrencyState(readCurrency() ?? preferredCurrency());
  }, []);

  // Other trees — the selector in the nav, a second provider in a portal — and
  // other tabs. Both keep the page consistent with the stored choice without
  // reloading.
  useEffect(() => {
    const onChoice = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (isCurrencyCode(detail)) setCurrencyState(detail);
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === CURRENCY_KEY && isCurrencyCode(event.newValue)) {
        setCurrencyState(event.newValue);
      }
    };

    window.addEventListener(CURRENCY_EVENT, onChoice);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CURRENCY_EVENT, onChoice);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setCurrency = useCallback((code: CurrencyCode) => {
    setCurrencyState(code);
    writeCurrency(code);
  }, []);

  /**
   * The price, polled while the page is open.
   *
   * `refetchIntervalInBackground` stays off, so a tab left open in another
   * window stops asking and picks up again when it is looked at. One retry:
   * this is a decoration, and hammering a rate-limited endpoint to decorate a
   * page is how the limit gets spent for everyone.
   */
  const { data: rates } = useQuery({
    queryKey: ["eth-price"],
    queryFn: fetchRates,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFRESH_MS,
    retry: 1,
  });

  /**
   * The rates this browser was served last time, standing in for the second
   * before the request above answers.
   *
   * Read in an effect and not during render, for the same reason the currency
   * above is: the server has no localStorage, and a first client render that
   * disagreed with the server's HTML is a hydration error. That costs the very
   * first paint, which has no conversions on it either way — what it buys is the
   * rest of the page load, where every figure is converted from the moment
   * React is running rather than from whenever the network gets back.
   *
   * It is a stand-in and never an authority: `rates` is preferred the instant it
   * exists, and lib/currency.ts refuses anything stale enough to be misleading.
   */
  const [cached, setCached] = useState<EthRates | null>(null);
  useEffect(() => setCached(readCachedRates()), []);

  // Written on every answer, so a page opened tomorrow starts from the last
  // price this reader was actually shown.
  useEffect(() => {
    if (rates) writeCachedRates(rates);
  }, [rates]);

  const rate = (rates ?? cached)?.[currency] ?? null;

  const value = useMemo<CurrencyContextValue>(
    () => ({
      currency,
      setCurrency,
      rate,
      toFiat: (eth) => {
        if (rate === null || eth === null || eth === undefined) return null;
        const amount = Number(eth);
        return Number.isFinite(amount) ? formatFiat(amount * rate, currency) : null;
      },
    }),
    [currency, setCurrency, rate]
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}
