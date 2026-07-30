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

/** Live sale figures, read from the contract when it responds. */
export type SaleStats = {
  /** Whole tokens sold. */
  sold: number;
  /** Whole tokens minted. */
  supply: number;
  /** Percentage of supply sold, 0–100. */
  percentSold: number;
  /** True when the numbers came from the chain rather than the database. */
  onChain: boolean;
  /**
   * Buyback terms, or null for a contract that has none — launches deployed
   * before `sell()` existed have no `sellPrice()` to read, and their holders
   * genuinely cannot sell back.
   */
  buyback: Buyback | null;
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

/** A token figure, trimmed the same way. */
export function formatTokens(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
