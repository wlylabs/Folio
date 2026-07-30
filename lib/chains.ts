import { createPublicClient, http, type PublicClient } from "viem";
import { baseSepolia, sepolia } from "viem/chains";

/**
 * The chains Folio supports. `slug` is what gets stored in tokens.chain, so a
 * token page can reconnect to the network it was actually deployed on instead
 * of assuming one.
 */
export const SUPPORTED_CHAINS = [
  { slug: "base-sepolia", chain: baseSepolia, rpcEnv: process.env.NEXT_PUBLIC_RPC_BASE_SEPOLIA },
  { slug: "sepolia", chain: sepolia, rpcEnv: process.env.NEXT_PUBLIC_RPC_SEPOLIA },
] as const;

export type ChainSlug = (typeof SUPPORTED_CHAINS)[number]["slug"];

export const DEFAULT_CHAIN_SLUG: ChainSlug = isChainSlug(
  process.env.NEXT_PUBLIC_DEFAULT_CHAIN
)
  ? process.env.NEXT_PUBLIC_DEFAULT_CHAIN
  : "base-sepolia";

export function isChainSlug(value: unknown): value is ChainSlug {
  return SUPPORTED_CHAINS.some((c) => c.slug === value);
}

export function chainBySlug(slug: string) {
  return SUPPORTED_CHAINS.find((c) => c.slug === slug);
}

export function chainIdBySlug(slug: string): number | undefined {
  return chainBySlug(slug)?.chain.id;
}

/** Human-readable network name for a stored slug. */
export function chainLabel(slug: string | null | undefined): string {
  if (!slug) return "UNKNOWN NETWORK";
  return chainBySlug(slug)?.chain.name.toUpperCase() ?? slug.toUpperCase();
}

/** Block explorer link for an address, when the chain publishes one. */
export function explorerAddressUrl(slug: string, address: string): string | null {
  const base = chainBySlug(slug)?.chain.blockExplorers?.default?.url;
  return base ? `${base}/address/${address}` : null;
}

const clients = new Map<string, PublicClient>();

/** A read-only client for server-side contract reads. Cached per chain. */
export function publicClientFor(slug: string): PublicClient | null {
  const entry = chainBySlug(slug);
  if (!entry) return null;

  const existing = clients.get(slug);
  if (existing) return existing;

  const client = createPublicClient({
    chain: entry.chain,
    transport: http(entry.rpcEnv || undefined),
  }) as PublicClient;
  clients.set(slug, client);
  return client;
}
