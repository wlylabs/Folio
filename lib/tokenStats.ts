import { formatEther, formatUnits, zeroAddress } from "viem";
import { FOLIO_SALE_ABI } from "@/lib/contracts/folioSale";
import { FOLIO_TOKEN_ABI } from "@/lib/contracts/folioToken";
import { deploymentFor } from "@/lib/contracts/deployment";
import { FOLIO_FACTORY_ABI } from "@/lib/contracts/folioFactory";
import { FOLIO_MIGRATOR_ABI } from "@/lib/contracts/folioMigrator";
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
 * The whole curve state in one round trip where the chain allows it.
 *
 * `allowFailure` is on so a single unsupported selector reports itself instead
 * of throwing away fourteen good reads — which is exactly how a FolioSale
 * announces that it isn't a FolioToken.
 *
 * A chain with no Multicall3 falls back to the same reads sent individually.
 * That used to be the end of the road: a refused multicall was read as "not a
 * curve", so on such a chain every listing rendered as offline with cached
 * numbers. Which chains have Multicall3 is not something this app should have
 * to know — see the note on `robinhoodMainnet` in lib/chains.ts.
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
    // No Multicall3 on this chain, or the RPC is down. One is worth retrying
    // read by read; the other will fail again immediately and cost thirteen
    // requests to say so, which is the cheaper mistake of the two.
    results = await Promise.all(
      reads.map((functionName) =>
        client
          .readContract({ ...contract, functionName })
          .then((result) => ({ status: "success" as const, result }))
          .catch(() => ({ status: "failure" as const, result: undefined }))
      )
    );
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

  /**
   * Migration state, read apart from the batch above on purpose.
   *
   * That batch is all-or-nothing: one failure and this stops being a curve at
   * all. A token cloned from an implementation older than migration answers
   * neither of these calls, and the right reading of that is "this launch cannot
   * migrate" — not "this is not a Folio token". Folding them in would have taken
   * every such page down.
   */
  const migration = await readMigration(client, contract);

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
    migrated: migration.migrated,
    migrator: migration.migrator,
    poolPrice: migration.poolPrice,
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
  // The factory on the token's *own* chain. Asking one chain's registry about
  // another chain's token would answer no for a token that is perfectly
  // genuine, which is the same badge as an impostor.
  const deployment = deploymentFor(chain);
  if (!deployment) return false;
  try {
    return await client.readContract({
      address: deployment.factory,
      abi: FOLIO_FACTORY_ABI,
      functionName: "isFolioToken",
      args: [address],
    });
  } catch {
    return false;
  }
}

/**
 * Whether this launch has moved to a pool, and what that pool is trading at.
 *
 * Every branch falls back to "no migration", because every reason this can fail
 * means exactly that: an implementation too old to have the functions, a launch
 * with no migrator configured, or a migrator that has not been called yet. None
 * of them is an error the page should show, and none of them should be allowed
 * to make an otherwise readable curve unreadable.
 */
async function readMigration(
  client: Client,
  contract: { address: `0x${string}`; abi: typeof FOLIO_TOKEN_ABI }
): Promise<{ migrated: boolean; migrator: string | null; poolPrice: number | null }> {
  const none = { migrated: false, migrator: null, poolPrice: null };

  let migrated: boolean;
  let migrator: `0x${string}`;
  try {
    [migrated, migrator] = await Promise.all([
      client.readContract({ ...contract, functionName: "migrated" }),
      client.readContract({ ...contract, functionName: "migrator" }),
    ]);
  } catch {
    return none;
  }

  if (migrator === zeroAddress) return none;
  if (!migrated) return { migrated: false, migrator, poolPrice: null };

  // The curve's own price froze at migration, so the live one has to come from
  // the pool. A failure here still leaves a correct page — it just cannot show
  // today's number.
  let poolPrice: number | null = null;
  try {
    const raw = await client.readContract({
      address: migrator,
      abi: FOLIO_MIGRATOR_ABI,
      functionName: "poolPrice",
      args: [contract.address],
    });
    poolPrice = Number(formatEther(raw));
  } catch {
    poolPrice = null;
  }

  return { migrated: true, migrator, poolPrice };
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
