import { formatEther, formatUnits, parseAbiItem } from "viem";
import { publicClientFor } from "@/lib/chains";

/**
 * A launch's trade history, read from its own event log.
 *
 * `TokensBought` and `TokensSold` both carry the marginal price the trade left
 * behind, so the curve's whole price history is already on chain — nothing has
 * to be recorded, and nothing can drift from what actually happened. This
 * module reads it back.
 *
 * Two properties are worth stating, because they are what make a chart drawn
 * from this trustworthy:
 *
 *  - **Every point is a settlement, not a sample.** `newPrice` is emitted by the
 *    contract after the effects of that trade, so the line is the price the
 *    curve actually held, not a poll that happened to catch it.
 *  - **The price holds between trades.** A constant-product curve only moves
 *    when someone trades against it, which is why the chart draws steps rather
 *    than sloping between points: sloping would invent movement that never
 *    happened.
 *
 * The scan runs backwards from the head of the chain, because the interesting
 * end of a price history is the recent end, and a launch with thousands of
 * trades should not cost thousands of blocks of scanning to show the last
 * forty.
 */

const TOKENS_BOUGHT = parseAbiItem(
  "event TokensBought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 newPrice)"
);

const TOKENS_SOLD = parseAbiItem(
  "event TokensSold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 newPrice)"
);

/** FolioToken.decimals, a constant on the contract. */
const DECIMALS = 18;

/**
 * Blocks per `eth_getLogs` call. The same ceiling lib/indexer.ts uses — public
 * RPCs cap the range, and Base's rejects anything much wider.
 */
const CHUNK = 9_000;

/**
 * How many chunks back a scan will walk before giving up on finding more.
 *
 * At Base's two-second blocks this reaches about six days, which is long enough
 * that a launch with any activity at all has some, and short enough that a dead
 * one costs a bounded number of round trips rather than a scan back to genesis.
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
   * True when this is a window onto the history rather than all of it — either
   * more than `limit` trades were found, or the walk stopped short of the
   * genesis block and older trades could be sitting behind it.
   */
  truncated: boolean;
  /** The block range actually walked, for the "showing the last N blocks" line. */
  fromBlock: number;
  toBlock: number;
  /**
   * Set when the scan failed part-way. Whatever was found before the failure is
   * still returned — half a price history beats an error message.
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
    return { trades: [], truncated: false, fromBlock: 0, toBlock: 0, error: `No RPC client for ${chain}.` };
  }

  const head = await client.getBlockNumber();
  // The floor of the walk. Guarded against a chain whose head is younger than
  // the window, which is only ever a local devnet — but an underflow on a
  // bigint is a panic, not a small number.
  const span = BigInt(CHUNK * MAX_CHUNKS);
  const floor = head > span ? head - span : 0n;

  const found: RawTrade[] = [];
  let scannedFrom = head;
  let error: string | undefined;

  try {
    for (let to = head; to >= floor; to -= BigInt(CHUNK)) {
      const from = to > BigInt(CHUNK - 1) && to - BigInt(CHUNK - 1) > floor ? to - BigInt(CHUNK - 1) : floor;

      const logs = await client.getLogs({
        address,
        events: [TOKENS_BOUGHT, TOKENS_SOLD],
        fromBlock: from,
        toBlock: to,
      });

      for (const log of logs) {
        const trade = decode(log);
        if (trade) found.push(trade);
      }

      scannedFrom = from;

      // Enough for the window being asked for. Older trades exist and are still
      // on chain; they are simply not what this panel is for.
      if (found.length >= limit) break;
      if (from === floor) break;
    }
  } catch (err) {
    // A partial history is still a history. The range that was reached is
    // reported honestly rather than implying the scan covered the whole window.
    error = err instanceof Error ? err.message : String(err);
  }

  // Chronological, and unambiguous within a block: two trades in one block are
  // ordered by where they sat in it.
  found.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)
  );

  // A scan that stopped at the window's floor rather than at block zero has not
  // seen the launch's whole life, and a panel that says "every trade" on the
  // strength of it would be wrong for any launch older than the window.
  const truncated = found.length > limit || scannedFrom > 0n;
  const kept = found.length > limit ? found.slice(-limit) : found;
  const timestamps = await blockTimestamps(client, kept);

  return {
    trades: kept.map((t) => ({
      side: t.side,
      trader: t.trader,
      eth: t.eth,
      tokens: t.tokens,
      price: t.price,
      blockNumber: Number(t.blockNumber),
      timestamp: timestamps.get(t.blockNumber) ?? null,
      txHash: t.txHash,
      logIndex: t.logIndex,
    })),
    truncated,
    fromBlock: Number(scannedFrom),
    toBlock: Number(head),
    error,
  };
}

type RawTrade = {
  side: "buy" | "sell";
  trader: string;
  eth: number;
  tokens: number;
  price: number;
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
};

/**
 * The parts of a viem log this module reads.
 *
 * Structural rather than imported: viem's `Log` is generic over the event list,
 * the pending flag and the ABI, and naming that type is a great deal more
 * ceremony than saying which four fields are actually used.
 */
type TradeLog = {
  eventName?: string;
  args?: Record<string, unknown>;
  blockNumber?: bigint | null;
  logIndex?: number | null;
  transactionHash?: string | null;
};

/**
 * One log into one trade, or null for anything malformed.
 *
 * A log missing its block number or hash is a pending log — viem hands those
 * back with nulls — and it has no place on a chart of settled prices.
 */
function decode(log: TradeLog): RawTrade | null {
  const args = log.args ?? {};
  const blockNumber = log.blockNumber;
  const txHash = log.transactionHash;
  if (blockNumber === null || blockNumber === undefined || !txHash) return null;
  if (log.logIndex === null || log.logIndex === undefined) return null;

  const newPrice = args.newPrice as bigint | undefined;
  if (newPrice === undefined) return null;

  if (log.eventName === "TokensBought") {
    const { buyer, ethIn, tokensOut } = args as { buyer?: string; ethIn?: bigint; tokensOut?: bigint };
    if (!buyer || ethIn === undefined || tokensOut === undefined) return null;

    return {
      side: "buy",
      trader: buyer.toLowerCase(),
      eth: Number(formatEther(ethIn)),
      tokens: Number(formatUnits(tokensOut, DECIMALS)),
      price: Number(formatEther(newPrice)),
      blockNumber,
      logIndex: log.logIndex,
      txHash,
    };
  }

  if (log.eventName === "TokensSold") {
    const { seller, tokensIn, ethOut } = args as { seller?: string; tokensIn?: bigint; ethOut?: bigint };
    if (!seller || tokensIn === undefined || ethOut === undefined) return null;

    return {
      side: "sell",
      trader: seller.toLowerCase(),
      eth: Number(formatEther(ethOut)),
      tokens: Number(formatUnits(tokensIn, DECIMALS)),
      price: Number(formatEther(newPrice)),
      blockNumber,
      logIndex: log.logIndex,
      txHash,
    };
  }

  return null;
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
      batch.map((blockNumber) =>
        client.getBlock({ blockNumber }).catch(() => null)
      )
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
