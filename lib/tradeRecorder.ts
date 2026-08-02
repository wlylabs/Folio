import { publicClientFor } from "@/lib/chains";
import { deploymentFor } from "@/lib/contracts/deployment";
import { serverSupabase, hasServiceRole } from "@/lib/supabaseAdmin";
import { TRADE_EVENTS, decodeTrade, type RawTrade } from "@/lib/tradeLog";

/**
 * The trade log, walked forward once and kept.
 *
 * ## The problem this exists for
 *
 * `lib/tradeHistory.ts` used to be the whole story: walk `eth_getLogs`
 * backwards from the head of the chain until enough trades turn up, and draw
 * them. That is honest and needs no database, and it has one number in it that
 * decides everything — how many blocks a page load can afford to walk. Twelve
 * chunks of nine thousand, which was about six days of two-second blocks.
 *
 * Robinhood Chain mines every 0.1 seconds. The same walk reaches **three
 * hours**. A launch's chart forgot its own opening by dinner, the "1W" and "1M"
 * chips could never have data behind them, and the fix inside that design —
 * walking further — is some six hundred `eth_getLogs` calls per reader per page
 * view. That is not a slower answer. It is no answer.
 *
 * ## What replaces it
 *
 * The log is read forward instead of backwards, from the block the token was
 * created in, and what it finds is written down. Each later run starts where
 * the last one stopped, so the cost of a scan tracks the blocks *since* it,
 * never the age of the launch. The chart then costs one indexed query.
 *
 * ## Still a cache, and never an authority
 *
 * Nothing here is a source of truth. Every row is a copy of an event the chain
 * emitted, the primary key is the log's own coordinates so re-reading a block
 * cannot double a trade, and a row that disagrees with the chain is a bug in
 * this file rather than a second opinion. No price anything settles at is ever
 * read from here — those come from `getBuyQuote` and `getSellPrice`, live, in
 * the trade panel.
 *
 * ## Service role only
 *
 * `lib/schema.sql` gives these two tables a read policy and no write policy at
 * all, so only the service role can write them. That is deliberate: a public
 * insert policy would let anyone holding the anon key invent a rally or a crash
 * in the one panel a reader looks at before buying, and no shape check makes a
 * forged trade safe. A deployment with no `SUPABASE_SERVICE_ROLE_KEY` records
 * nothing and reads live — the behaviour this app had before the table existed.
 */

/**
 * Blocks per `eth_getLogs` call. The ceiling `lib/indexer.ts` uses — public
 * RPCs cap the range, and asking for a wider one is refused rather than
 * truncated.
 */
const CHUNK = 9_000;

/**
 * Chunks one run will walk before stopping and writing down where it got to.
 *
 * A first scan of an old launch could be thousands of chunks, and doing them
 * all inside one request is a request that times out having written nothing.
 * So a run is bounded, its progress is recorded, and the next one continues —
 * the chart fills in over a few page views rather than blocking on one. Higher
 * than the live scan's twelve because this cost is paid once per range of
 * blocks in total, not once per reader.
 */
const MAX_CHUNKS_PER_RUN = 40;

/** Rows per insert. Postgres is happy with far more; this bounds the payload. */
const BATCH = 500;

/** Block headers fetched at once. Public RPCs throttle a wide fan-out. */
const TIMESTAMP_CONCURRENCY = 6;

/**
 * How far behind the head a scan stops.
 *
 * A reorg rewrites recent blocks, and a trade recorded from a block that is
 * later replaced is a row describing something that did not happen — with a
 * primary key that stops the correct version replacing it. Holding back a few
 * seconds of blocks is the cheap protection; `lib/tradeHistory.ts` covers the
 * gap by reading those blocks live on every request anyway, so nothing is
 * missing from the chart, it is only missing from the table.
 */
const REORG_MARGIN = 200n;

/** One `eth_getLogs` range, inclusive at both ends. */
export type ScanChunk = { from: bigint; to: bigint };

export type ScanPlan = {
  /** The ranges this run will read, in order. Empty when there is nothing new. */
  chunks: ScanChunk[];
  /** The block the cursor should be moved to once they are all written. */
  through: bigint;
  /** True when the plan stopped on its budget with blocks still unread. */
  more: boolean;
};

/**
 * Which blocks this run reads, worked out before any of them are.
 *
 * Separated from the reading because it is the part where a mistake is silent
 * and permanent. Every other failure here retries: a chunk that throws leaves
 * the cursor where it was, a row that conflicts is ignored because it is the
 * same row. But a gap between two chunks is a range the cursor has already
 * moved past, so the trades in it are never looked for again — a hole in a
 * launch's price history that nothing will ever notice or fill.
 *
 * Hence a pure function, and hence `test/tradeRecorder.test.mjs`.
 *
 * @param head       the chain's current head
 * @param cursorLast the last block already recorded, or null on a first run
 * @param firstBlock the block the token was created in
 */
export function planScan(
  head: bigint,
  cursorLast: bigint | null,
  firstBlock: bigint,
  { chunk = CHUNK, maxChunks = MAX_CHUNKS_PER_RUN, margin = REORG_MARGIN } = {}
): ScanPlan {
  // Stop short of the head. A reorg rewrites recent blocks, and a trade
  // recorded from one that is later replaced is a row describing something that
  // did not happen — sitting behind a primary key that stops the correct
  // version replacing it. Guarded against a chain younger than the margin,
  // which is only ever a local devnet; a bigint underflow is a panic.
  const safeHead = head > margin ? head - margin : 0n;

  // A first run starts at the launch. A later one starts at the block after the
  // last one it finished, which is what makes a scan cost the blocks since it
  // rather than the age of the launch.
  const start = cursorLast === null ? firstBlock : cursorLast + 1n;

  if (start > safeHead) {
    // Nothing new. The cursor stays exactly where it was — moving it to
    // `safeHead` here would skip the margin's blocks the moment they aged in.
    return { chunks: [], through: cursorLast ?? start - 1n, more: false };
  }

  const chunks: ScanChunk[] = [];
  let from = start;

  while (from <= safeHead && chunks.length < maxChunks) {
    const end = from + BigInt(chunk - 1);
    const to = end > safeHead ? safeHead : end;
    chunks.push({ from, to });
    from = to + 1n;
  }

  return {
    chunks,
    // The end of the last chunk, never `safeHead` — those differ exactly when
    // the budget ran out, and recording the wrong one is the gap described
    // above.
    through: chunks[chunks.length - 1].to,
    more: from <= safeHead,
  };
}

export type RecordResult = {
  /** False when this deployment has no service role and records nothing. */
  recording: boolean;
  /** Trades written by this run. */
  written: number;
  /** The block the recorder has now read up to, or null when it has not run. */
  through: bigint | null;
  /** The token's creation block, once found. */
  firstBlock: bigint | null;
  /** True when the run stopped on its chunk budget with blocks still to read. */
  more: boolean;
  /** Set when the run failed part-way. Whatever it wrote before that stays. */
  error?: string;
};

const idle: RecordResult = {
  recording: false,
  written: 0,
  through: null,
  firstBlock: null,
  more: false,
};

/**
 * Bring one launch's stored trade log up to date.
 *
 * Safe to call on every request: with the cursor at the head there is one
 * `eth_getLogs` and nothing to write, and concurrent callers are collapsed by
 * the caller's own in-flight map (`app/api/token/[address]/trades/route.ts`).
 */
export async function recordTrades(
  chain: string,
  address: `0x${string}`
): Promise<RecordResult> {
  if (!hasServiceRole) return idle;

  const db = serverSupabase();
  const client = publicClientFor(chain);
  if (!db || !client) return idle;

  const token = address.toLowerCase();

  try {
    const head = await client.getBlockNumber();
    const cursor = await readCursor(db, chain, token);

    const firstBlock = cursor?.firstBlock ?? (await findCreationBlock(client, chain, address));
    if (firstBlock === null) {
      // No contract at that address on this chain. Nothing to record, and
      // nothing wrong — a listing can name an address that was never deployed.
      return { ...idle, recording: true };
    }

    const plan = planScan(head, cursor?.lastBlock ?? null, firstBlock);
    if (plan.chunks.length === 0) {
      return {
        recording: true,
        written: 0,
        through: cursor?.lastBlock ?? null,
        firstBlock,
        more: false,
      };
    }

    let written = 0;
    // Advanced per chunk rather than set from the plan at the end: a run that
    // throws half way through has still written the chunks before the failure,
    // and the cursor should say so rather than either forgetting them or
    // claiming the ones that never landed.
    let through = plan.chunks[0].from - 1n;

    try {
      for (const { from, to } of plan.chunks) {
        const logs = await client.getLogs({
          address,
          events: TRADE_EVENTS,
          fromBlock: from,
          toBlock: to,
        });

        const trades = logs.map(decodeTrade).filter((t): t is RawTrade => t !== null);
        if (trades.length > 0) {
          written += await write(db, client, chain, token, trades);
        }

        through = to;
      }
    } finally {
      // In a `finally` for the same reason: progress that was made is progress,
      // and re-reading it on the next run is free where re-reading from the
      // launch is not.
      if (through >= plan.chunks[0].from) {
        await writeCursor(db, chain, token, firstBlock, through);
      }
    }

    return { recording: true, written, through, firstBlock, more: plan.more };
  } catch (err) {
    console.error(`Recording trades for ${token} on ${chain} failed:`, err);
    return {
      ...idle,
      recording: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type Cursor = { firstBlock: bigint; lastBlock: bigint };

async function readCursor(
  db: NonNullable<ReturnType<typeof serverSupabase>>,
  chain: string,
  token: string
): Promise<Cursor | null> {
  const { data, error } = await db
    .from("trade_cursors")
    .select("first_block, last_block")
    .eq("chain", chain)
    .eq("token_address", token)
    .maybeSingle();

  if (error || !data) return null;
  return { firstBlock: BigInt(data.first_block), lastBlock: BigInt(data.last_block) };
}

async function writeCursor(
  db: NonNullable<ReturnType<typeof serverSupabase>>,
  chain: string,
  token: string,
  firstBlock: bigint,
  lastBlock: bigint
) {
  const { error } = await db.from("trade_cursors").upsert(
    {
      chain,
      token_address: token,
      first_block: firstBlock.toString(),
      last_block: lastBlock.toString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "chain,token_address" }
  );

  // A cursor that did not save costs the next run a re-read of the same blocks,
  // which the primary key makes harmless. It is not worth failing a page over.
  if (error) console.error("Trade cursor did not save:", error.message);
}

/**
 * Write a chunk's trades, and report how many were new.
 *
 * `upsert` with `ignoreDuplicates` rather than plain insert: a run that
 * overlaps one that already recorded these blocks — two instances, a retry
 * after a failed cursor write — should be a no-op rather than an error. The
 * primary key is the log's own coordinates, so "already recorded" and "the same
 * trade" are the same statement.
 */
async function write(
  db: NonNullable<ReturnType<typeof serverSupabase>>,
  client: NonNullable<ReturnType<typeof publicClientFor>>,
  chain: string,
  token: string,
  trades: RawTrade[]
): Promise<number> {
  const timestamps = await blockTimestamps(client, trades);

  const rows = trades.map((t) => ({
    chain,
    token_address: token,
    block_number: t.blockNumber.toString(),
    log_index: t.logIndex,
    tx_hash: t.txHash,
    side: t.side,
    trader: t.trader,
    eth: t.eth,
    tokens: t.tokens,
    price: t.price,
    block_time: timestamps.has(t.blockNumber)
      ? new Date(timestamps.get(t.blockNumber)! * 1000).toISOString()
      : null,
  }));

  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error, count } = await db
      .from("trades")
      .upsert(slice, { onConflict: "chain,token_address,block_number,log_index", ignoreDuplicates: true, count: "exact" });

    if (error) throw new Error(`Writing trades failed: ${error.message}`);
    written += count ?? 0;
  }

  return written;
}

/**
 * When each of these blocks was mined.
 *
 * A log carries no timestamp, so the header has to be read for it. Blocks are
 * deduplicated first — several trades in one block cost one read — and the
 * reads run a few at a time, because a public RPC answers a burst of hundreds
 * with a rate limit. A block that cannot be read leaves its trades with a null
 * time rather than a guessed one.
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

/**
 * The block a token was created in, found by bisection.
 *
 * `eth_getCode` at a block says whether the contract existed yet, which turns
 * "when was this deployed" into a binary search — about fourteen calls between
 * the factory's own deploy block and the head, paid once per launch and then
 * stored in `trade_cursors.first_block` forever.
 *
 * The factory's block is the floor because no launch can predate the factory
 * that made it. Where the record does not carry one, zero is the floor and the
 * search costs a handful more calls rather than being wrong.
 *
 * Returns null for an address with no code at the head, which is a listing
 * naming something that was never deployed — nothing to record, and not an
 * error.
 */
async function findCreationBlock(
  client: NonNullable<ReturnType<typeof publicClientFor>>,
  chain: string,
  address: `0x${string}`
): Promise<bigint | null> {
  let high = await client.getBlockNumber();

  const atHead = await client.getCode({ address, blockNumber: high });
  if (!atHead || atHead === "0x") return null;

  let low = deploymentFor(chain)?.deployedAtBlock ?? 0n;

  // The floor has to be a block with no code at it, or the invariant below is
  // false from the start. A factory record newer than the token — a redeploy —
  // is exactly that case, and it is cheaper to check than to reason about.
  if (low > 0n) {
    const atFloor = await client.getCode({ address, blockNumber: low });
    if (atFloor && atFloor !== "0x") low = 0n;
  }

  // Invariant: no code at `low`, code at `high`.
  while (low + 1n < high) {
    const mid = (low + high) / 2n;
    const code = await client.getCode({ address, blockNumber: mid });
    if (code && code !== "0x") high = mid;
    else low = mid;
  }

  return high;
}
