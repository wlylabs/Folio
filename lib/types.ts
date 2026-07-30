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
