import { formatUnits, parseAbiItem } from "viem";
import { publicClientFor } from "@/lib/chains";
import { FACTORY_DEPLOYMENT, openingPriceEth } from "@/lib/contracts/deployment";
import { serverSupabase } from "@/lib/supabaseAdmin";

/**
 * Backfills the listings table from the factory's `TokenCreated` log.
 *
 * The chain is where launches actually happen. The create page writes its own
 * row the moment it sees the event, which covers the common case, but it is not
 * the only way a token gets made: `contracts/script/CreateToken.s.sol` makes
 * them, so does anyone calling the factory directly, and a browser that closed
 * between the transaction confirming and the insert landing leaves a live token
 * with no listing. This closes all of those the same way — by reading the log
 * rather than trusting that every writer remembered to tell us.
 *
 * It is idempotent: every run diffs the log against what the table already has
 * and inserts only what is missing, so running it twice does nothing the second
 * time.
 *
 * Two ways to run it:
 *
 *   - `GET /api/indexer` — for a cron, a deploy hook, or a curl. See
 *     app/api/indexer/route.ts.
 *   - `npm run watch:launches` — a long-lived process that subscribes to the
 *     event and calls the endpoint as launches land. See
 *     scripts/watch-launches.mjs.
 *
 * Neither one runs on page load. Pages read the table.
 */

const TOKEN_CREATED = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 totalSupply, (uint256 virtualEthReserve, uint256 maxReserveCap, uint256 graduationThreshold, uint16 feeBps, uint16 priceMoveAlertBps) config)"
);

/**
 * Blocks per `eth_getLogs` call. Public RPCs cap the range — Base's rejects
 * anything much wider than this — so a scan is chunked rather than asked for in
 * one span it would refuse.
 */
const CHUNK = 9_000;

export type IndexResult = {
  /** Launches seen in the log over the scanned range. */
  found: number;
  /** Rows written, i.e. launches that had no listing. */
  inserted: number;
  /** First and last block scanned. */
  fromBlock: string;
  toBlock: string;
  /** Populated when something went wrong mid-run; the rows already written stay. */
  error?: string;
};

/**
 * Where the last scan stopped, per process.
 *
 * A serverless instance starts cold with this empty and re-scans from the
 * factory's deploy block, which is correct but not free. Setting
 * `deployedAtBlock` in the deployment record (DeployFactory.s.sol writes it) or
 * `INDEXER_FROM_BLOCK` keeps that first scan short.
 */
let cursor: bigint | null = null;
let resolvedStart: bigint | null = null;

export async function syncLaunches(options: { fromBlock?: bigint } = {}): Promise<IndexResult> {
  const deployment = FACTORY_DEPLOYMENT;
  if (!deployment) {
    return { found: 0, inserted: 0, fromBlock: "0", toBlock: "0", error: "No factory configured." };
  }

  const client = publicClientFor(deployment.chain);
  if (!client) {
    return {
      found: 0,
      inserted: 0,
      fromBlock: "0",
      toBlock: "0",
      error: `No RPC client for ${deployment.chain}.`,
    };
  }

  const db = serverSupabase();
  if (!db) {
    return { found: 0, inserted: 0, fromBlock: "0", toBlock: "0", error: "Supabase is not configured." };
  }

  const head = await client.getBlockNumber();
  const start = options.fromBlock ?? cursor ?? (await resolveStartBlock(client, deployment.factory));

  const launches: LaunchLog[] = [];
  let scanned = start;

  try {
    for (let from = start; from <= head; from += BigInt(CHUNK)) {
      const to = min(from + BigInt(CHUNK - 1), head);

      const logs = await client.getLogs({
        address: deployment.factory,
        event: TOKEN_CREATED,
        fromBlock: from,
        toBlock: to,
      });

      for (const log of logs) {
        const args = log.args as Partial<LaunchArgs>;
        if (!args.token || !args.creator || !args.name || !args.symbol || args.totalSupply === undefined) {
          continue;
        }
        launches.push({
          token: args.token.toLowerCase(),
          creator: args.creator.toLowerCase(),
          name: args.name,
          symbol: args.symbol,
          totalSupply: args.totalSupply,
          config: args.config,
          txHash: log.transactionHash,
        });
      }

      scanned = to;
    }
  } catch (err) {
    // A partial scan is still progress: whatever was found before the failure
    // gets written, and the cursor stays where it was so the next run retries
    // the range that failed.
    const inserted = await insertMissing(db, deployment.chain, launches);
    return {
      found: launches.length,
      inserted,
      fromBlock: start.toString(),
      toBlock: scanned.toString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const inserted = await insertMissing(db, deployment.chain, launches);

  // Only advance on a clean run, and only to the head we actually reached.
  cursor = head + 1n;

  return {
    found: launches.length,
    inserted,
    fromBlock: start.toString(),
    toBlock: head.toString(),
  };
}

type LaunchArgs = {
  token: `0x${string}`;
  creator: `0x${string}`;
  name: string;
  symbol: string;
  totalSupply: bigint;
  config: {
    virtualEthReserve: bigint;
    maxReserveCap: bigint;
    graduationThreshold: bigint;
    feeBps: number;
    priceMoveAlertBps: number;
  };
};

type LaunchLog = {
  token: string;
  creator: string;
  name: string;
  symbol: string;
  totalSupply: bigint;
  config?: LaunchArgs["config"];
  txHash: `0x${string}`;
};

/**
 * Writes the launches that have no listing yet.
 *
 * The article is a placeholder, because a launch made outside the site has no
 * article — the point is that the token is *visible* rather than invisible until
 * someone notices. A creator who later publishes through the site gets a real
 * one; the row is keyed by contract address either way.
 */
async function insertMissing(
  db: NonNullable<ReturnType<typeof serverSupabase>>,
  chain: string,
  launches: LaunchLog[]
): Promise<number> {
  if (launches.length === 0) return 0;

  const addresses = [...new Set(launches.map((l) => l.token))];

  const { data: existing, error } = await db
    .from("tokens")
    .select("contract_address")
    .in("contract_address", addresses);

  if (error) throw new Error(`Reading existing listings failed: ${error.message}`);

  const known = new Set((existing ?? []).map((row) => String(row.contract_address).toLowerCase()));
  const missing = launches.filter((l) => !known.has(l.token));
  if (missing.length === 0) return 0;

  const rows = missing.map((l) => {
    const wholeSupply = Number(formatUnits(l.totalSupply, 18));
    return {
      contract_address: l.token,
      chain,
      name: l.name,
      symbol: l.symbol,
      supply: wholeSupply,
      starting_price: openingPriceEth(wholeSupply, l.config),
      creator_wallet: l.creator,
      article_title: l.name,
      article_body: `<p>Launched on chain without an article. The curve, the reserve and every trade are readable on the contract.</p>`,
      avatar_url: null,
      deploy_tx: l.txHash,
    };
  });

  // `ignoreDuplicates` rather than a merge: a listing that already exists has an
  // article somebody wrote, and a placeholder must never overwrite it. The
  // unique index on contract_address is what makes the race safe.
  const { error: insertError, count } = await db
    .from("tokens")
    .upsert(rows, { onConflict: "contract_address", ignoreDuplicates: true, count: "exact" });

  if (insertError) throw new Error(`Writing listings failed: ${insertError.message}`);
  return count ?? rows.length;
}

/**
 * The block to start scanning from.
 *
 * The deployment record carries it when DeployFactory.s.sol wrote the record.
 * When it doesn't — a hand-written record, or one from before that field — the
 * block is found by bisecting on `eth_getCode`, which costs about twenty reads
 * once per process and is a great deal cheaper than scanning from genesis.
 */
async function resolveStartBlock(
  client: NonNullable<ReturnType<typeof publicClientFor>>,
  factory: `0x${string}`
): Promise<bigint> {
  if (resolvedStart !== null) return resolvedStart;

  const configured = process.env.INDEXER_FROM_BLOCK
    ? BigInt(process.env.INDEXER_FROM_BLOCK)
    : FACTORY_DEPLOYMENT?.deployedAtBlock ?? 0n;

  if (configured > 0n) {
    resolvedStart = configured;
    return configured;
  }

  let low = 0n;
  let high = await client.getBlockNumber();

  // Invariant: there is no code at `low`, and there is code at `high`. If the
  // factory has no code at head it isn't deployed on this chain at all, and
  // scanning from zero would be a long way to discover that.
  const atHead = await client.getCode({ address: factory, blockNumber: high });
  if (!atHead || atHead === "0x") {
    resolvedStart = high;
    return high;
  }

  while (low + 1n < high) {
    const mid = (low + high) / 2n;
    const code = await client.getCode({ address: factory, blockNumber: mid });
    if (code && code !== "0x") high = mid;
    else low = mid;
  }

  resolvedStart = high;
  return high;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
