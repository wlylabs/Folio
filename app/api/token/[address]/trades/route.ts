import { NextResponse } from "next/server";
import { isChainSlug } from "@/lib/chains";
import { fetchTradeHistory, type TradeHistory } from "@/lib/tradeHistory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A launch's recent trades, cached.
 *
 * `GET /api/token/<address>/trades?chain=<slug>` answers with the price history
 * read out of the token's own `TokensBought` / `TokensSold` log — see
 * lib/tradeHistory.ts for what the numbers mean.
 *
 * It is a server route rather than a scan from the browser for the same reasons
 * /api/eth-price is: a log scan is a dozen `eth_getLogs` calls plus a block
 * header per trade, the answer is identical for every reader, and a public RPC
 * would rate-limit the fiftieth visitor rather than the fiftieth scan.
 *
 * It is also deliberately *not* part of the token page's server render. The
 * article, the fact box and the trade panel are the page; the chart is a scan
 * that can take a second or fail on a slow RPC, and none of the other three
 * should wait on it.
 */

/** How long a scan is served as fresh, in ms. Roughly a block or two. */
const TTL_MS = 20_000;

/** Cached scans, keyed by chain and address. */
const cache = new Map<string, { history: TradeHistory; fetchedAt: number }>();

/** Scans in flight, so a burst of readers shares one walk of the log. */
const inflight = new Map<string, Promise<TradeHistory>>();

/**
 * Cache entries kept. A launchpad has an unbounded number of listings and this
 * map lives for the life of the process, so it evicts the coldest rather than
 * growing until the instance runs out of memory.
 */
const MAX_ENTRIES = 200;

export async function GET(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const address = (await params).address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return NextResponse.json({ error: "Not an address." }, { status: 400 });
  }

  const url = new URL(request.url);
  const chain = url.searchParams.get("chain");
  if (!isChainSlug(chain)) {
    return NextResponse.json({ error: "Unknown or missing chain." }, { status: 400 });
  }

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam && /^\d+$/.test(limitParam) ? Number(limitParam) : undefined;

  const key = `${chain}:${address}:${limit ?? "default"}`;

  try {
    const history = await cached(key, () =>
      fetchTradeHistory(chain, address as `0x${string}`, { limit })
    );

    return NextResponse.json(history, {
      // A partial scan is still worth serving — it just should not be held as
      // long as a clean one, because the next call may well get the rest.
      headers: {
        "cache-control": history.error
          ? "no-store"
          : "public, s-maxage=20, stale-while-revalidate=120",
      },
    });
  } catch (err) {
    // Logged in full, answered in general: a viem error names the endpoint it
    // was talking to, and that is the server's business rather than the
    // caller's. The chart reads the status, not the sentence.
    console.error("Trade history scan failed:", err);
    return NextResponse.json(
      { error: "The trade history could not be read right now." },
      { status: 502, headers: { "cache-control": "no-store" } }
    );
  }
}

async function cached(key: string, run: () => Promise<TradeHistory>): Promise<TradeHistory> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.history;

  const existing = inflight.get(key);
  if (existing) return existing;

  const scan = run()
    .then((history) => {
      // Re-inserting moves the key to the end of the map's insertion order,
      // which is what makes the eviction below least-recently-written.
      cache.delete(key);
      cache.set(key, { history, fetchedAt: Date.now() });
      if (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return history;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, scan);
  return scan;
}
