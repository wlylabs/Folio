import { formatEther, formatUnits, parseAbiItem } from "viem";

/**
 * The two events a curve emits when it trades, and how to read one.
 *
 * Shared ground for the two things that read them: `lib/tradeRecorder.ts`,
 * which walks the log forward and writes what it finds down, and
 * `lib/tradeHistory.ts`, which reads the recent end of it live. Both have to
 * agree exactly about what a log means — a chart drawn from two decoders that
 * round differently is a chart with a seam in it at the point where one hands
 * over to the other.
 *
 * Two properties make a chart drawn from these trustworthy, and they are worth
 * stating here rather than at either caller:
 *
 *  - **Every point is a settlement, not a sample.** `newPrice` is emitted by
 *    the contract after the effects of that trade, so the line is the price the
 *    curve actually held, not a poll that happened to catch it.
 *  - **The price holds between trades.** A constant-product curve only moves
 *    when somebody trades against it, which is why the chart draws steps rather
 *    than sloping between points: sloping would invent movement that never
 *    happened.
 */

const TOKENS_BOUGHT = parseAbiItem(
  "event TokensBought(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 newPrice)"
);

const TOKENS_SOLD = parseAbiItem(
  "event TokensSold(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 newPrice)"
);

/** Both legs, for a log filter that wants the whole history. */
export const TRADE_EVENTS = [TOKENS_BOUGHT, TOKENS_SOLD] as const;

/** FolioToken.decimals, a constant on the contract. */
const DECIMALS = 18;

/** One trade, as it comes off the chain. */
export type RawTrade = {
  side: "buy" | "sell";
  /** Who traded. Lowercased, like every address Folio stores. */
  trader: string;
  /** ETH into the curve on a buy, out of it on a sell. Gross of the fee. */
  eth: number;
  /** Whole tokens issued on a buy, burned on a sell. */
  tokens: number;
  /** Marginal price the trade left behind, in ETH per whole token. */
  price: number;
  blockNumber: bigint;
  /**
   * Position in the block. Carried through because a transaction hash is not a
   * unique key — a contract calling `buy` twice emits two trades under one hash
   * — and both a list and a primary key need one.
   */
  logIndex: number;
  txHash: string;
};

/**
 * The parts of a viem log this module reads.
 *
 * Structural rather than imported: viem's `Log` is generic over the event list,
 * the pending flag and the ABI, and naming that type is a great deal more
 * ceremony than saying which five fields are actually used.
 */
export type TradeLog = {
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
 * back with nulls — and it has no place in a record of settled prices.
 */
export function decodeTrade(log: TradeLog): RawTrade | null {
  const args = log.args ?? {};
  const blockNumber = log.blockNumber;
  const txHash = log.transactionHash;
  if (blockNumber === null || blockNumber === undefined || !txHash) return null;
  if (log.logIndex === null || log.logIndex === undefined) return null;

  const newPrice = args.newPrice as bigint | undefined;
  if (newPrice === undefined) return null;

  if (log.eventName === "TokensBought") {
    const { buyer, ethIn, tokensOut } = args as {
      buyer?: string;
      ethIn?: bigint;
      tokensOut?: bigint;
    };
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
    const { seller, tokensIn, ethOut } = args as {
      seller?: string;
      tokensIn?: bigint;
      ethOut?: bigint;
    };
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

/** Chronological, and unambiguous within a block. */
export function chronological<T extends { blockNumber: bigint; logIndex: number }>(
  trades: T[]
): T[] {
  return [...trades].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : Number(a.blockNumber - b.blockNumber)
  );
}
