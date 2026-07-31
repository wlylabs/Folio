import { NextResponse } from "next/server";
import { CURRENCIES, parseRates, type EthRates } from "@/lib/currency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The ETH reference price, cached.
 *
 * `GET /api/eth-price` answers `{ usd, idr, fetchedAt }` — what one ETH is
 * worth in every currency the selector offers, fetched once and held for a
 * minute. It exists as a server route rather than a fetch from the browser for
 * three reasons: CoinGecko's free tier is rate limited per IP and a hundred
 * readers would spend it in seconds; the answer is identical for everybody, so
 * caching it once is strictly better than caching it a hundred times; and an
 * API key, if this ever needs one, has no business in a bundle.
 *
 * Both currencies come back on every call even though the reader is only
 * looking at one, so flipping the selector is instant and costs no request.
 *
 * Set `COINGECKO_API_KEY` to use a Pro plan's higher limits. Without it the
 * public endpoint is used, which is what a testnet launchpad needs.
 */

/** How long a fetched price is served as fresh, in ms. */
const TTL_MS = 60_000;

/**
 * How long a price keeps being served after it goes stale, when CoinGecko is
 * down or rate limiting. Ten minutes of slightly-old ETH price is a better
 * answer than no answer for a figure that is explicitly an estimate.
 */
const STALE_MS = 10 * 60_000;

/** Upstream is allowed this long before we give up on it. */
const TIMEOUT_MS = 6_000;

const VS_CURRENCIES = CURRENCIES.map((c) => c.code.toLowerCase()).join(",");

type Cached = { rates: EthRates; fetchedAt: number };

/**
 * Process-wide, deliberately. Serverless gives each instance its own copy and
 * a cold start simply fetches once — the cache is an optimisation, never a
 * correctness requirement.
 */
let cache: Cached | null = null;

/** The fetch currently in flight, so a burst of callers shares one request. */
let inflight: Promise<Cached> | null = null;

function endpoint(): { url: string; headers: HeadersInit } {
  const key = process.env.COINGECKO_API_KEY;
  const host = key ? "https://pro-api.coingecko.com" : "https://api.coingecko.com";

  return {
    url: `${host}/api/v3/simple/price?ids=ethereum&vs_currencies=${VS_CURRENCIES}`,
    headers: {
      accept: "application/json",
      ...(key ? { "x-cg-pro-api-key": key } : {}),
    },
  };
}

async function fetchRates(): Promise<Cached> {
  const { url, headers } = endpoint();

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // Next would otherwise cache this fetch itself, on its own schedule; the
    // TTL above is the one that should govern.
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`CoinGecko answered ${response.status}`);
  }

  const body: unknown = await response.json();
  const rates = parseRates((body as { ethereum?: unknown } | null)?.ethereum);
  if (!rates) {
    throw new Error("CoinGecko returned no usable ethereum price");
  }

  return { rates, fetchedAt: Date.now() };
}

/** The cached price, refreshed if it has aged out. */
async function currentRates(): Promise<Cached> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;

  inflight ??= fetchRates()
    .then((fresh) => {
      cache = fresh;
      return fresh;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export async function GET() {
  try {
    const { rates, fetchedAt } = await currentRates();

    return NextResponse.json(
      { ...lowercased(rates), fetchedAt, stale: false },
      {
        // A CDN in front of this may hold it for the same minute, and keep
        // serving the old copy while it refreshes.
        headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" },
      }
    );
  } catch (err) {
    console.error("ETH price fetch failed:", err);

    // A recent-enough cached price beats an error. Past that, say so plainly
    // and let the UI drop the conversion line rather than print a stale or
    // invented number.
    if (cache && Date.now() - cache.fetchedAt < STALE_MS) {
      return NextResponse.json(
        { ...lowercased(cache.rates), fetchedAt: cache.fetchedAt, stale: true },
        { headers: { "cache-control": "no-store" } }
      );
    }

    return NextResponse.json(
      { error: "ETH price is unavailable right now." },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}

/** `{ USD: 3200 }` -> `{ usd: 3200 }`, the shape the client parses. */
function lowercased(rates: EthRates): Record<string, number> {
  return Object.fromEntries(Object.entries(rates).map(([code, rate]) => [code.toLowerCase(), rate]));
}
