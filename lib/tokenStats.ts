import { formatEther, formatUnits } from "viem";
import { FOLIO_SALE_ABI } from "@/lib/contracts/folioSale";
import { FOLIO_TOKEN_ABI } from "@/lib/contracts/folioToken";
import { FACTORY_DEPLOYMENT } from "@/lib/contracts/deployment";
import { FOLIO_FACTORY_ABI } from "@/lib/contracts/folioFactory";
import { publicClientFor } from "@/lib/chains";
import {
  percentSold,
  type Buyback,
  type LegacyStats,
  type OfflineStats,
  type Token,
  type TokenStats,
} from "@/lib/types";

/** FolioToken.decimals, a constant on the contract. */
export const DECIMALS = 18;

/**
 * Read a listing's live figures off its contract.
 *
 * The chain is the source of truth; `tokens.sold_amount` and friends are a
 * fallback for rows whose contract cannot be reached, because nothing on chain
 * writes back to Postgres and a stored number can only ever be stale.
 *
 * Which ABI a listing answers to is discovered, not stored: the curve reads are
 * tried first and a launch that doesn't have `curveSupply()` falls through to
 * the retired FolioSale shape. That keeps listings from before the factory
 * working without a migration column saying which kind they are.
 */
export async function fetchTokenStats(token: Token): Promise<TokenStats> {
  const client = publicClientFor(token.chain);
  if (!client) return offline(token);

  const curve = await fetchCurveStats(client, token);
  if (curve) return curve;

  const legacy = await fetchLegacyStats(client, token);
  if (legacy) return legacy;

  return offline(token);
}

function offline(token: Token): OfflineStats {
  const sold = Number(token.sold_amount ?? 0);
  const supply = Number(token.supply ?? 0);
  return { kind: "offline", onChain: false, sold, supply, percentSold: percentSold(sold, supply) };
}

type Client = NonNullable<ReturnType<typeof publicClientFor>>;

/**
 * The whole curve state in one round trip.
 *
 * `allowFailure` is on so a single unsupported selector reports itself instead
 * of throwing away fourteen good reads — which is exactly how a FolioSale
 * announces that it isn't a FolioToken.
 */
async function fetchCurveStats(client: Client, token: Token) {
  const address = token.contract_address as `0x${string}`;
  const contract = { address, abi: FOLIO_TOKEN_ABI } as const;

  const reads = [
    "curveSupply",
    "tokensSold",
    "currentPrice",
    "marketCap",
    "getReserveBalance",
    "maxReserveCap",
    "graduationThreshold",
    "ethHeadroom",
    "reserveHealthBps",
    "feeBps",
    "graduated",
    "tradingPaused",
    "creator",
  ] as const;

  let results;
  try {
    results = await client.multicall({
      contracts: reads.map((functionName) => ({ ...contract, functionName })),
      allowFailure: true,
    });
  } catch {
    // No multicall3 on this chain, or the RPC is down. Either way we cannot
    // tell a curve from a legacy sale here; let the caller try the other shape.
    return null;
  }

  // All or nothing. A FolioToken answers every one of these; a FolioSale
  // answers none of them. A partial answer is some third thing we have no
  // business rendering as a curve, so it falls through to the other shapes.
  if (results.some((r) => r.status === "failure")) return null;

  const [
    curveSupply,
    tokensSold,
    currentPrice,
    marketCap,
    reserve,
    reserveCap,
    graduationThreshold,
    headroom,
    reserveHealthBps,
    feeBps,
    graduated,
    paused,
    creator,
  ] = results.map((r) => r.result) as [
    bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint,
    number, boolean, boolean, `0x${string}`,
  ];

  const supply = Number(formatUnits(curveSupply, DECIMALS));
  const sold = Number(formatUnits(tokensSold, DECIMALS));

  return {
    kind: "curve" as const,
    onChain: true as const,
    supply,
    sold,
    percentSold: percentSold(sold, supply),
    price: Number(formatEther(currentPrice)),
    marketCap: Number(formatEther(marketCap)),
    reserve: Number(formatEther(reserve)),
    reserveCap: Number(formatEther(reserveCap)),
    graduationThreshold: Number(formatEther(graduationThreshold)),
    headroom: Number(formatEther(headroom)),
    reserveHealthBps: Number(reserveHealthBps),
    feeBps: Number(feeBps),
    graduated,
    paused,
    creator,
    verified: await isFactoryToken(client, token.chain, address),
  };
}

/**
 * Does the configured factory claim this token?
 *
 * A `false` here is not cosmetic. `FolioToken` reads its emergency stop from
 * whoever initialized it, so a clone made outside the platform answers to a
 * stranger's pause switch — the registry is the only way to tell the two apart
 * from the outside, and the page says so when the answer is no.
 */
async function isFactoryToken(client: Client, chain: string, address: `0x${string}`) {
  if (!FACTORY_DEPLOYMENT || FACTORY_DEPLOYMENT.chain !== chain) return false;
  try {
    return await client.readContract({
      address: FACTORY_DEPLOYMENT.factory,
      abi: FOLIO_FACTORY_ABI,
      functionName: "isFolioToken",
      args: [address],
    });
  } catch {
    return false;
  }
}

/** The retired fixed-price sale. Kept so listings launched under it keep working. */
async function fetchLegacyStats(client: Client, token: Token): Promise<LegacyStats | null> {
  const contract = { address: token.contract_address as `0x${string}`, abi: FOLIO_SALE_ABI } as const;

  try {
    const [sold, totalSupply, decimals] = await Promise.all([
      client.readContract({ ...contract, functionName: "sold" }),
      client.readContract({ ...contract, functionName: "totalSupply" }),
      client.readContract({ ...contract, functionName: "decimals" }),
    ]);

    const soldWhole = Number(formatUnits(sold, decimals));
    const supplyWhole = Number(formatUnits(totalSupply, decimals));

    return {
      kind: "legacy",
      onChain: true,
      sold: soldWhole,
      supply: supplyWhole,
      percentSold: percentSold(soldWhole, supplyWhole),
      // Read separately: a pre-buyback launch has no sellPrice(), and that must
      // not cost the page its sale figures.
      buyback: await fetchBuyback(client, token),
    };
  } catch {
    return null;
  }
}

/**
 * The buyback terms, or null if this contract has none.
 *
 * `sellPrice()` was added alongside `sell()`, so a read that reverts is how we
 * recognise a launch from before the buyback existed — those tokens are
 * buy-only, and the UI has to say so rather than offering a sell button that
 * always fails.
 */
async function fetchBuyback(client: Client, token: Token): Promise<Buyback | null> {
  const address = token.contract_address as `0x${string}`;

  try {
    const [sellPrice, reserve] = await Promise.all([
      client.readContract({ address, abi: FOLIO_SALE_ABI, functionName: "sellPrice" }),
      client.getBalance({ address }),
    ]);

    return {
      sellPrice: Number(formatEther(sellPrice)),
      reserve: Number(formatEther(reserve)),
    };
  } catch {
    return null;
  }
}
