import { publicClientFor } from "@/lib/chains";
import { serverSupabase } from "@/lib/supabaseAdmin";
import { recordTrades } from "@/lib/tradeRecorder";
import { TRADE_EVENTS, chronological, decodeTrade, type RawTrade } from "@/lib/tradeLog";

/**
 * A launch's trade history: what was recorded, plus what has happened since.
 *
 * `TokensBought` and `TokensSold` both carry the marginal price the trade left
 * behind, so the curve's whole price history is already on chain and nothing
 * has to be recorded for it to exist. What has to be recorded is the *reach* of
 * it — see the long note in `lib/tradeRecorder.ts`. The short version: reading
 * it live means walking `eth_getLogs` backwards from the head, that walk is
 * bounded by what a page load can afford, and on a chain mining ten blocks a
 * second the bound is three hours.
 *
 * So there are two sources here and one answer:
 *
 *  - **The `trades` table**, written forward by the recorder and covering
 *    everything from the launch's own block to wherever the recorder last got
 *    to. This is where the depth comes from.
 *  - **The chain**, for the blocks after that — the recorder deliberately stops
 *    short of the head so a reorg cannot leave a wrong row behind a primary key
 *    that blocks the right one. Those last blocks are read live on every
 *    request, which is a single `eth_getLogs`.
 *
 * A deployment with no service role has no recorder and no table to read, and
 * falls all the way back to the bounded backwards walk — the behaviour this
 * module had before any of this existed. It says so in `truncated`, which is
 * what makes the panel print "the last N trades" rather than claiming to show
 * every one.
 */

/**
 * Blocks per `eth_getLogs` call, for the live half. The same ceiling
 * `lib/indexer.ts` uses — public RPCs cap the range.
 */
const CHUNK = 9_000;

/**
 * How many chunks the *fallback* walk covers before giving up.
 *
 * This is the un-recorded path only: no service role, or a token the recorder
 * has not reached yet. 108,000 blocks is three hours on Robinhood Chain and six
 * days on a two-second chain, and neither number is chosen — it is simply as
 * far as a dozen round trips reach. Depth is the recorder's job, not this
 * one's.
 */
const MAX_CHUNKS = 12;

/** Trades kept, newest-last. Also the ceiling on block-header reads below. */
const DEFAULT_LIMIT = 40;

/** Block headers fetched at once. Public RPCs throttle a wide fan-out. */
const TIMESTAMP_CONCURRENCY = 6;

export type Trade = {
  side: "buy" | "sell";
  /** Who traded. Lowercased, like every address Folio stores. */
  trader: string;
  /** ETH into the curve on a buy, out of it on a sell. Gross of the fee. */
  eth: number;
  /** Whole tokens issued on a buy, burned on a sell. */
  tokens: number;
  /** Marginal price the trade left behind, in ETH per whole token. */
  price: number;
  blockNumber: number;
  /** Unix seconds, or null when the block header could not be read. */
  timestamp: number | null;
  txHash: string;
  /**
   * Position in the block. Carried through because a transaction hash is not a
   * unique key — a contract calling `buy` twice emits two trades under one hash
   * — and a list needs one.
   */
  logIndex: number;
};

export type TradeHistory = {
  /** Oldest first, so a chart can plot it without re-sorting. */
  trades: Trade[];
  /**
   * True when this is a window onto the history rather than all of it — more
   * than `limit` trades exist, or the walk stopped short of the launch's own
   * first block and older trades could be sitting behind it.
   */
  truncated: boolean;
  /** The block range this answer covers, for the "showing the last N" line. */
  fromBlock: number;
  toBlock: number;
  /**
   * Where the depth came from. `recorded` means the stored log was read and the
   * history reaches back to the launch; `live` means it was walked from the
   * head and reaches as far as a dozen calls do. The panel does not draw them
   * differently — this is for an operator reading `/api/token/<a>/trades` and
   * wondering why a month-old launch shows an afternoon.
   */
  source: "recorded" | "live";
  /**
   * Set when part of this failed. Whatever was found before it is still
   * returned — half a price history beats an error message.
   */
  error?: string;
};

export async function fetchTradeHistory(
  chain: string,
  address: `0x${string}`,
  options: { limit?: number } = {}
): Promise<TradeHistory> {
  const limit = clampLimit(options.limit);

  const client = publicClientFor(chain);
  if (!client) {
    return {
      trades: [],
      truncated: false,
      fromBlock: 0,
      toBlock: 0,
      source: "live",
      error: `No RPC client for ${chain}.`,
    };
  }

  /*
   * Bring the record up to date first, and let it fail quietly.
   *
   * Doing this on the read path rather than on a cron is what makes the feature
   * need no operator: a launch nobody looks at costs nothing, and one somebody
   * is looking at is caught up by the act of looking. The route in front of
   * this caches for twenty seconds and collapses concurrent callers, so the
   * cost is one run per token per twenty seconds however many readers there
   * are.
   *
   * A recorder that could not write is not a reason to serve no chart — the
   * live walk below still works, it just does not reach as far.
   */
  const recorded = await recordTrades(chain, address);

  if (recorded.recording && recorded.through !== null) {
    const stored = await readStored(chain, address, limit, recorded, client);
    if (stored) return stored;
  }

  return liveWalk(client, address, limit, recorded.error);
}

/**
 * The stored history, topped up with the blocks the recorder held back.
 *
 * Returns null when the table could not be read at all, which sends the caller
 * to the live walk rather than to an empty chart.
 */
async function readStored(
  chain: string,
  address: `0x${string}`,
  limit: number,
  recorded: { through: bigint | null; firstBlock: bigint | null; more: boolean },
  client: NonNullable<ReturnType<typeof publicClientFor>>
): Promise<TradeHistory | null> {
  const db = serverSupabase();
  if (!db || recorded.through === null) return null;

  // Newest first out of the index, reversed below. Asking for one more than the
  // limit is how "there are older ones" is known without a count query.
  const { data, error } = await db
    .from("trades")
    .select("side, trader, eth, tokens, price, block_number, log_index, tx_hash, block_time")
    .eq("chain", chain)
    .eq("token_address", address.toLowerCase())
    .order("block_number", { ascending: false })
    .order("log_index", { ascending: false })
    .limit(limit + 1);

  if (error) {
    console.error("Reading the stored trade log failed:", error.message);
    return null;
  }

  const rows = (data ?? []).map(fromRow);
  const moreStored = rows.length > limit;
  const kept = moreStored ? rows.slice(0, limit) : rows;
  kept.reverse();

  // The blocks the recorder deliberately stopped short of. One call, and it is
  // what keeps a trade that settled ten seconds ago on the chart.
  const tail = await tailFromChain(client, address, recorded.through + 1n);

  const all = chronological([...kept, ...tail.trades]);
  const trimmed = all.length > limit ? all.slice(-limit) : all;
  const timestamps = await blockTimestamps(client, tail.trades);

  return {
    trades: trimmed.map((t) => toTrade(t, timestamps)),
    // `more` on the recorder means it stopped on its chunk budget with blocks
    // still to read, so the history is genuinely partial even where this page
    // of it is not.
    truncated: moreStored || recorded.more,
    fromBlock: Number(trimmed[0]?.blockNumber ?? recorded.firstBlock ?? 0n),
    toBlock: Number(tail.head),
    source: "recorded",
    error: tail.error,
  };
}

/** The trades in the blocks after the recorder's cursor. */
async function tailFromChain(
  client: NonNullable<ReturnType<typeof publicClientFor>>,
  address: `0x${string}`,
  from: bigint
): Promise<{ trades: RawTrade[]; head: bigint; error?: string }> {
  try {
    const head = await client.getBlockNumber();
    if (from > head) return { trades: [], head };

    const trades: RawTrade[] = [];
    // Bounded like everything else that runs per request. The recorder's margin
    // is two hundred blocks, so one chunk is more than enough headroom; the
    // loop is what keeps it correct if that margin is ever widened.
    for (let start = from, chunk = 0; start <= head && chunk < MAX_CHUNKS; chunk++) {
      const to = start + BigInt(CHUNK - 1) > head ? head : start + BigInt(CHUNK - 1);

      const logs = await client.getLogs({
        address,
        events: TRADE_EVENTS,
        fromBlock: start,
        toBlock: to,
      });
      for (const log of logs) {
        const trade = decodeTrade(log);
        if (trade) trades.push(trade);
      }

      start = to + 1n;
    }

    return { trades, head };
  } catch (err) {
    // The stored half is still a history. Reporting the failure rather than
    // dropping the whole answer is the same bargain the walk below makes.
    return {
      trades: [],
      head: from > 0n ? from - 1n : 0n,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The original design, kept for the deployments and the moments that need it:
 * walk backwards from the head until enough trades turn up.
 *
 * Backwards because the interesting end of a price history is the recent end,
 * and a launch with thousands of trades should not cost thousands of blocks of
 * scanning to show the last forty.
 */
async function liveWalk(
  client: NonNullable<ReturnType<typeof publicClientFor>>,
  address: `0x${string}`,
  limit: number,
  priorError?: string
): Promise<TradeHistory> {
  const head = await client.getBlockNumber();
  // Guarded against a chain whose head is younger than the window, which is
  // only ever a local devnet — but an underflow on a bigint is a panic, not a
  // small number.
  const span = BigInt(CHUNK * MAX_CHUNKS);
  const floor = head > span ? head - span : 0n;

  const found: RawTrade[] = [];
  let scannedFrom = head;
  let error = priorError;

  try {
    for (let to = head; to >= floor; to -= BigInt(CHUNK)) {
      const from =
        to > BigInt(CHUNK - 1) && to - BigInt(CHUNK - 1) > floor ? to - BigInt(CHUNK - 1) : floor;

      const logs = await client.getLogs({
        address,
        events: TRADE_EVENTS,
        fromBlock: from,
        toBlock: to,
      });

      for (const log of logs) {
        const trade = decodeTrade(log);
        if (trade) found.push(trade);
      }

      scannedFrom = from;

      // Enough for the window being asked for. Older trades exist and are still
      // on chain; they are simply not what this walk is for.
      if (found.length >= limit) break;
      if (from === floor) break;
    }
  } catch (err) {
    // A partial history is still a history. The range that was reached is
    // reported honestly rather than implying the scan covered the whole window.
    error = err instanceof Error ? err.message : String(err);
  }

  const sorted = chronological(found);

  // A walk that stopped at the window's floor rather than at block zero has not
  // seen the launch's whole life, and a panel that says "every trade" on the
  // strength of it would be wrong for any launch older than the window.
  const truncated = sorted.length > limit || scannedFrom > 0n;
  const kept = sorted.length > limit ? sorted.slice(-limit) : sorted;
  const timestamps = await blockTimestamps(client, kept);

  return {
    trades: kept.map((t) => toTrade(t, timestamps)),
    truncated,
    fromBlock: Number(scannedFrom),
    toBlock: Number(head),
    source: "live",
    error,
  };
}

/** A stored row back into the shape the rest of this module works in. */
function fromRow(row: {
  side: string;
  trader: string;
  eth: number | string;
  tokens: number | string;
  price: number | string;
  block_number: number | string;
  log_index: number;
  tx_hash: string;
  block_time: string | null;
}): RawTrade & { timestamp: number | null } {
  return {
    side: row.side === "sell" ? "sell" : "buy",
    trader: row.trader,
    // `numeric` comes back as a string from PostgREST, which is right for a
    // column that can hold more precision than a double — and wrong for the
    // chart, which plots numbers.
    eth: Number(row.eth),
    tokens: Number(row.tokens),
    price: Number(row.price),
    blockNumber: BigInt(row.block_number),
    logIndex: row.log_index,
    txHash: row.tx_hash,
    timestamp: row.block_time ? Math.floor(Date.parse(row.block_time) / 1000) : null,
  };
}

/**
 * One trade for the wire.
 *
 * A stored row already carries its own timestamp; one just read off the chain
 * takes it from the headers fetched alongside. Which is why the map is
 * consulted first and the row's own value is the fallback rather than the other
 * way round — the map only ever holds blocks from this request.
 */
function toTrade(
  trade: RawTrade & { timestamp?: number | null },
  timestamps: Map<bigint, number>
): Trade {
  return {
    side: trade.side,
    trader: trade.trader,
    eth: trade.eth,
    tokens: trade.tokens,
    price: trade.price,
    blockNumber: Number(trade.blockNumber),
    timestamp: timestamps.get(trade.blockNumber) ?? trade.timestamp ?? null,
    txHash: trade.txHash,
    logIndex: trade.logIndex,
  };
}

/**
 * When each of these blocks was mined.
 *
 * A log carries no timestamp, so the header has to be read for it. Blocks are
 * deduplicated first — several trades in one block cost one read, not several —
 * and the reads run a few at a time, because a public RPC answers a burst of
 * forty with a rate limit.
 *
 * A block that cannot be read is left out rather than guessed at. The chart
 * falls back to even spacing when that happens, which is visibly approximate;
 * an invented timestamp would not be.
 */
async function blockTimestamps(
  client: NonNullable<ReturnType<typeof publicClientFor>>,
  trades: RawTrade[]
): Promise<Map<bigint, number>> {
  const blocks = [...new Set(trades.map((t) => t.blockNumber))];
  const found = new Map<bigint, number>();

  for (let i = 0; i < blocks.length; i += TIMESTAMP_CONCURRENCY) {
    const batch = blocks.slice(i, i + TIMESTAMP_CONCURRENCY);
    const headers = await Promise.all(
      batch.map((blockNumber) => client.getBlock({ blockNumber }).catch(() => null))
    );

    headers.forEach((header, index) => {
      if (header) found.set(batch[index], Number(header.timestamp));
    });
  }

  return found;
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(200, Math.max(2, Math.floor(value)));
}
