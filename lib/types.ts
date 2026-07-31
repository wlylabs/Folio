/** A row of the `tokens` table (see lib/schema.sql). */
export type Token = {
  id: string;
  contract_address: string;
  chain: string;
  name: string;
  symbol: string;
  supply: number;
  starting_price: number;
  creator_wallet: string;
  article_title: string;
  article_body: string;
  avatar_url: string | null;
  sold_amount: number | null;
  deploy_tx: string | null;
  created_at: string;
};

/**
 * Live figures for a listing, read from its contract.
 *
 * Three shapes, because three kinds of listing exist and the page has to be
 * honest about which it is looking at:
 *
 * - `curve`   — a FolioToken launched by the current factory. Bonding curve,
 *               live two-way pricing, a reserve you can audit.
 * - `legacy`  — a FolioSale from the one-contract-per-launch design. Fixed
 *               price, fixed buyback, no curve. Still live, still tradable.
 * - `offline` — nothing readable at that address: an unreachable RPC, or a row
 *               whose contract_address never had a contract behind it.
 */
export type TokenStats = CurveStats | LegacyStats | OfflineStats;

export type CurveStats = {
  kind: "curve";
  onChain: true;
  /** Whole tokens the curve may ever issue. */
  supply: number;
  /** Whole tokens issued so far. */
  sold: number;
  /** Percentage of supply sold, 0–100. */
  percentSold: number;
  /** Marginal price of one whole token, in ETH. Moves with every trade. */
  price: number;
  /** Fully diluted value at the marginal price, in ETH. */
  marketCap: number;
  /** Real ETH backing the curve. This is what sellers are paid out of. */
  reserve: number;
  /** Ceiling on that reserve — this launch's blast radius, in ETH. */
  reserveCap: number;
  /** Reserve at which buys close, in ETH. Zero means graduation is disabled. */
  graduationThreshold: number;
  /** ETH the curve can still take in before the binding ceiling stops it. */
  headroom: number;
  /** Reserve over what it owes sellers, in basis points. 10000 = exactly covered. */
  reserveHealthBps: number;
  /** Creator fee per leg, in basis points. */
  feeBps: number;
  /** True once the curve closed itself to buys at its threshold. */
  graduated: boolean;
  /** True while the platform emergency stop is engaged. Blocks buy and sell. */
  paused: boolean;
  /** Fee recipient, as the contract reports it. */
  creator: string;
  /**
   * True when the configured factory vouches for this token
   * (`factory.isFolioToken`). False means it answers to the FolioToken ABI but
   * was not launched here — a clone somebody made of the implementation, or a
   * launch from an older factory.
   */
  verified: boolean;
};

export type LegacyStats = {
  kind: "legacy";
  onChain: true;
  sold: number;
  supply: number;
  percentSold: number;
  /**
   * Buyback terms, or null for a contract that has none — launches deployed
   * before `sell()` existed have no `sellPrice()` to read, and their holders
   * genuinely cannot sell back.
   */
  buyback: Buyback | null;
};

export type OfflineStats = {
  kind: "offline";
  onChain: false;
  sold: number;
  supply: number;
  percentSold: number;
};

export type Buyback = {
  /** ETH paid per whole token sold back. */
  sellPrice: number;
  /** ETH the contract holds to pay sellers with. */
  reserve: number;
};

export function shortAddress(address: string | null | undefined): string {
  if (!address || address.length < 10) return address || "unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Percentage of supply sold, guarding the divide-by-zero and null cases. */
export function percentSold(sold: number, supply: number): number {
  if (!Number.isFinite(sold) || !Number.isFinite(supply) || supply <= 0) return 0;
  return Math.min(100, Math.max(0, (sold / supply) * 100));
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatAmount(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

/**
 * An ETH figure at a length a person can read. Testnet prices run to several
 * decimal places, so this keeps enough of them to distinguish 0.0002 from
 * 0.00019 without printing all eighteen.
 */
export function formatEth(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";
  if (n < 0.000001) return "<0.000001";
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/**
 * An ETH figure kept to significant figures rather than decimal places.
 *
 * {formatEth} stops at six decimals and prints "<0.000001" below that, which is
 * right for a balance and wrong for a curve price: a launch that opens around
 * 1e-9 ETH per token has its whole price history inside that clamp, and an axis
 * whose high and low both read "<0.000001" says nothing at all.
 *
 * So this keeps four significant figures wherever they fall. Use it where the
 * distance between two small numbers is the point — chart scales, per-token
 * prices — and {formatEth} everywhere else, so ordinary ETH amounts keep
 * reading the way they do across the rest of the site.
 */
export function formatEthPrice(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  if (n === 0) return "0";

  // Past this the digits run off the end of a caption, and an exponent is the
  // honest way to say "smaller than this format can show".
  if (Math.abs(n) < 1e-9) return n.toExponential(2);

  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
}

/** A publication date, or "undated" for a row that has no usable timestamp. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "undated";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "undated"
    : date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** The same date, short enough to sit in a card footer. */
export function formatDateShort(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * How long ago something happened, from a Unix timestamp in seconds.
 *
 * Chain events carry block timestamps, and "4m ago" is what a reader wants from
 * a trade tape — a wall-clock time makes them do the subtraction. Past a week
 * the relative form stops meaning anything, so it becomes a date.
 *
 * A missing timestamp says so rather than falling back to the epoch: a block
 * header that didn't load is not a trade from 1970.
 */
export function formatRelativeTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "time unknown";

  const elapsed = Math.floor(Date.now() / 1000) - Number(seconds);
  // Clock skew between the reader and the chain, not a trade from the future.
  if (elapsed < 45) return "just now";
  if (elapsed < 3_600) return `${Math.round(elapsed / 60)}m ago`;
  if (elapsed < 86_400) return `${Math.round(elapsed / 3_600)}h ago`;
  if (elapsed < 7 * 86_400) return `${Math.round(elapsed / 86_400)}d ago`;

  return new Date(Number(seconds) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/** Basis points as a percentage: 100 -> "1%", 25 -> "0.25%". */
export function formatBps(bps: number | null | undefined): string {
  const n = Number(bps ?? 0);
  if (!Number.isFinite(n)) return "0%";
  return `${(n / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/** A token figure, trimmed the same way. */
export function formatTokens(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
