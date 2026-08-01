import { createPublicClient, defineChain, http, type PublicClient } from "viem";

/**
 * Robinhood Chain — an Arbitrum Orbit L2, EVM-equivalent, ETH for gas.
 *
 * Mainnet, and the only network Folio runs on. The ETH spent here is real:
 * there is no faucet anywhere in this codebase because there is nothing to
 * claim, and every "get free test ETH" affordance was removed with the testnet
 * rather than left pointing at a network that no longer exists.
 *
 * Defined here rather than imported from `viem/chains`, which does not ship it.
 * The values match `contracts/script/FolioScript.sol`'s NetworkProfile for
 * 4663, and DEPLOYMENT.md section 4 is where they came from.
 *
 * No `contracts.multicall3` entry: whether Multicall3 sits at the canonical
 * address here has not been confirmed on chain, and claiming it would send
 * every read down a path the RPC may reject. `lib/tokenStats.ts` falls back to
 * individual reads when a multicall is refused, so the only cost of leaving
 * this out is one round trip per read on a chain that does support it — which
 * is the right way round for a fact we haven't verified.
 *
 * The public RPC is rate limited. Set NEXT_PUBLIC_RPC_ROBINHOOD_MAINNET to a
 * dedicated endpoint for anything with traffic; the same note is in
 * .env.example for the Foundry side.
 */
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
      apiUrl: "https://robinhoodchain.blockscout.com/api",
    },
  },
  testnet: false,
});

/**
 * The chains Folio supports. `slug` is what gets stored in tokens.chain, so a
 * token page can reconnect to the network it was actually deployed on instead
 * of assuming one.
 *
 * A chain being here means the app can *read* it and a wallet can be asked to
 * switch to it. Whether you can *launch* on it is a separate question, answered
 * by `deployments/<slug>.json` — see lib/contracts/deployment.ts.
 *
 * The same list `FolioScript.onlySupportedNetwork` allows: the app offers to
 * switch a wallet to a chain, so listing one the contracts refuse to deploy on
 * would move a reader somewhere Folio has nothing to trade.
 *
 * One chain, and it is a mainnet: a trade on `robinhood-mainnet` spends real
 * ETH. Nothing in this file guards that — the wallet's own confirmation is the
 * guard. Folio used to carry Base Sepolia alongside it for rehearsal, and the
 * list stayed an array when that went: everything downstream reads it as one,
 * so restoring a second network is an entry here plus a deployment record,
 * not a refactor.
 */
export const SUPPORTED_CHAINS = [
  {
    slug: "robinhood-mainnet",
    chain: robinhoodMainnet,
    rpcEnv: process.env.NEXT_PUBLIC_RPC_ROBINHOOD_MAINNET,
  },
] as const;

export type ChainSlug = (typeof SUPPORTED_CHAINS)[number]["slug"];

export const DEFAULT_CHAIN_SLUG: ChainSlug = isChainSlug(
  process.env.NEXT_PUBLIC_DEFAULT_CHAIN
)
  ? process.env.NEXT_PUBLIC_DEFAULT_CHAIN
  : "robinhood-mainnet";

export function isChainSlug(value: unknown): value is ChainSlug {
  return SUPPORTED_CHAINS.some((c) => c.slug === value);
}

/**
 * Whether a wallet sitting on this chain id is somewhere Folio can work.
 *
 * The question a connected wallet asks: RainbowKit answers it internally to
 * decide whether to show "Wrong network", and ChainSync needs the same answer
 * to decide whether a switch is worth requesting. Being on the *wrong*
 * supported chain is not this — that is settled per transaction, against the
 * chain the token was actually deployed on.
 */
export function isSupportedChainId(id: number | undefined | null): boolean {
  return id !== undefined && id !== null && SUPPORTED_CHAINS.some((c) => c.chain.id === id);
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

/** Block explorer link for a transaction, when the chain publishes one. */
export function explorerTxUrl(slug: string, hash: string): string | null {
  const base = chainBySlug(slug)?.chain.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : null;
}

/** Block explorer link for an address, when the chain publishes one. */
export function explorerAddressUrl(slug: string, address: string): string | null {
  const base = chainBySlug(slug)?.chain.blockExplorers?.default?.url;
  return base ? `${base}/address/${address}` : null;
}

/**
 * Where the browser can reach a chain's RPC through Folio's own origin.
 *
 * `app/api/rpc/[slug]/route.ts` serves it. Relative on purpose: the point of
 * the route is that it is the same host the page came from, and a reader whose
 * network cannot reach the RPC directly can still reach that.
 */
export function rpcProxyPath(slug: ChainSlug): string {
  return `/api/rpc/${slug}`;
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
