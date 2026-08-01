import { formatUnits, parseAbiItem } from "viem";
import { publicClientFor } from "@/lib/chains";
import {
  FACTORY_DEPLOYMENTS,
  deploymentFor,
  openingPriceEth,
  type FactoryDeployment,
} from "@/lib/contracts/deployment";
import { serverSupabase } from "@/lib/supabaseAdmin";

/**
 * Backfills the listings table from every factory's `TokenCreated` log.
 *
 * One scan per configured chain, each with its own cursor: two launches on two
 * networks are two logs, and a run that only ever read one of them would leave
 * the other's listings invisible forever. Robinhood Chain is the only chain
 * configured today, so that is one scan — the loop is what keeps it correct if
 * a second is ever added.
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

/** What one chain's scan did. */
export type ChainIndexResult = {
  /** The chain slug, i.e. which `deployments/<slug>.json` this came from. */
  chain: string;
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

export type IndexResult = {
  /** Launches seen across every chain scanned. */
  found: number;
  /** Rows written across every chain scanned. */
  inserted: number;
  /** The range scanned on the first chain. Block numbers only mean something
   *  within one chain, so the per-chain breakdown is the real answer. Kept at
   *  the top level because callers — scripts/watch-launches.mjs, a curl — were
   *  reading it before there was more than one chain. */
  fromBlock: string;
  toBlock: string;
  /** Every chain's failure, joined. Absent when they all succeeded. */
  error?: string;
  /** One entry per chain scanned, in SUPPORTED_CHAINS order. */
  chains: ChainIndexResult[];
};

/**
 * Where the last scan stopped, per chain, per process.
 *
 * A serverless instance starts cold with these empty and re-scans from each
 * factory's deploy block, which is correct but not free. Setting
 * `deployedAtBlock` in the deployment record (DeployFactory.s.sol writes it) or
 * `INDEXER_FROM_BLOCK` keeps that first scan short.
 *
 * Keyed by chain because block numbers on different chains have nothing to do
 * with each other — one shared cursor would have each chain skipping whatever
 * the other had already passed.
 */
const cursors = new Map<string, bigint>();
const resolvedStarts = new Map<string, bigint>();

/**
 * Scans every configured factory, or just one when `chain` names it.
 *
 * A chain that fails does not stop the others: each gets its own entry in
 * `chains`, and the top-level `error` is set only so a caller that never looked
 * at the breakdown still sees that something went wrong.
 */
export async function syncLaunches(
  options: { fromBlock?: bigint; chain?: string } = {}
): Promise<IndexResult> {
  const targets = options.chain
    ? [deploymentFor(options.chain)].filter((d): d is FactoryDeployment => d !== null)
    : FACTORY_DEPLOYMENTS;

  if (targets.length === 0) {
    return {
      found: 0,
      inserted: 0,
      fromBlock: "0",
      toBlock: "0",
      error: options.chain
        ? `No factory configured on ${options.chain}.`
        : "No factory configured.",
      chains: [],
    };
  }

  // A block number belongs to one chain. Applying it to several would rescan
  // one from the right place and the others from a height that means nothing
  // there — silently, and looking like a successful run. Refuse instead.
  if (options.fromBlock !== undefined && targets.length > 1) {
    return {
      found: 0,
      inserted: 0,
      fromBlock: options.fromBlock.toString(),
      toBlock: "0",
      error: `A start block only means something on one chain. Name one: ?chain=${targets
        .map((t) => t.chain)
        .join(" | ")}`,
      chains: [],
    };
  }

  const db = serverSupabase();
  if (!db) {
    return {
      found: 0,
      inserted: 0,
      fromBlock: "0",
      toBlock: "0",
      error: "Supabase is not configured.",
      chains: [],
    };
  }

  const chains: ChainIndexResult[] = [];
  for (const deployment of targets) {
    chains.push(await syncChain(db, deployment, options.fromBlock));
  }

  const errors = chains
    .filter((c) => c.error)
    .map((c) => `${c.chain}: ${c.error}`);

  return {
    found: chains.reduce((sum, c) => sum + c.found, 0),
    inserted: chains.reduce((sum, c) => sum + c.inserted, 0),
    fromBlock: chains[0].fromBlock,
    toBlock: chains[0].toBlock,
    error: errors.length > 0 ? errors.join("; ") : undefined,
    chains,
  };
}

async function syncChain(
  db: NonNullable<ReturnType<typeof serverSupabase>>,
  deployment: FactoryDeployment,
  fromBlock?: bigint
): Promise<ChainIndexResult> {
  const client = publicClientFor(deployment.chain);
  if (!client) {
    return {
      chain: deployment.chain,
      found: 0,
      inserted: 0,
      fromBlock: "0",
      toBlock: "0",
      error: `No RPC client for ${deployment.chain}.`,
    };
  }

  // Before the scan proper, and inside its own guard: an RPC that cannot answer
  // `eth_blockNumber` must fail this chain, not the whole run. The other chains
  // are on other providers and have nothing to do with it.
  let head: bigint;
  let start: bigint;
  try {
    head = await client.getBlockNumber();
    start =
      fromBlock ?? cursors.get(deployment.chain) ?? (await resolveStartBlock(client, deployment));
  } catch (err) {
    return {
      chain: deployment.chain,
      found: 0,
      inserted: 0,
      fromBlock: "0",
      toBlock: "0",
      error: err instanceof Error ? err.message : String(err),
    };
  }

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
    const inserted = await insertMissing(db, deployment.chain, launches).catch(() => 0);
    return {
      chain: deployment.chain,
      found: launches.length,
      inserted,
      fromBlock: start.toString(),
      toBlock: scanned.toString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const inserted = await insertMissing(db, deployment.chain, launches);

    // Only advance on a clean run, and only to the head we actually reached.
    cursors.set(deployment.chain, head + 1n);

    return {
      chain: deployment.chain,
      found: launches.length,
      inserted,
      fromBlock: start.toString(),
      toBlock: head.toString(),
    };
  } catch (err) {
    // A write failure leaves the cursor alone, so the next run re-reads this
    // range and tries the insert again.
    return {
      chain: deployment.chain,
      found: launches.length,
      inserted: 0,
      fromBlock: start.toString(),
      toBlock: head.toString(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
 *
 * Two things stop a write: a listing that already exists, and a tombstone in
 * `delisted_tokens`. The second matters because deleting a row cannot on its own
 * remove a launch — the log it was read from is permanent, so without the
 * tombstone this function would faithfully put every deleted listing back.
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
  const delisted = await readDelisted(db, addresses);
  const missing = launches.filter((l) => !known.has(l.token) && !delisted.has(l.token));
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
 * The addresses among `addresses` that have been delisted by hand.
 *
 * A database that predates the table (schema.sql not re-run) answers with
 * Postgres' 42P01 — undefined_table — and that is treated as "nothing has been
 * delisted", which is true of every such database. Any other failure throws:
 * guessing "nothing" on a transient read error is how a deleted listing comes
 * back.
 */
async function readDelisted(
  db: NonNullable<ReturnType<typeof serverSupabase>>,
  addresses: string[]
): Promise<Set<string>> {
  const { data, error } = await db
    .from("delisted_tokens")
    .select("contract_address")
    .in("contract_address", addresses);

  if (error) {
    if (error.code === "42P01") return new Set();
    throw new Error(`Reading delisted launches failed: ${error.message}`);
  }

  return new Set((data ?? []).map((row) => String(row.contract_address).toLowerCase()));
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
  deployment: FactoryDeployment
): Promise<bigint> {
  const cached = resolvedStarts.get(deployment.chain);
  if (cached !== undefined) return cached;

  // INDEXER_FROM_BLOCK is one number for every chain, so it only makes sense
  // when one chain is configured. With more than one it is ignored in favour of
  // each record's own deploy block — a block height from another chain is not a
  // hint, it is a wrong answer that looks like a right one.
  const configured =
    process.env.INDEXER_FROM_BLOCK && FACTORY_DEPLOYMENTS.length === 1
      ? BigInt(process.env.INDEXER_FROM_BLOCK)
      : deployment.deployedAtBlock;

  if (configured > 0n) {
    resolvedStarts.set(deployment.chain, configured);
    return configured;
  }

  const factory = deployment.factory;
  let low = 0n;
  let high = await client.getBlockNumber();

  // Invariant: there is no code at `low`, and there is code at `high`. If the
  // factory has no code at head it isn't deployed on this chain at all, and
  // scanning from zero would be a long way to discover that.
  const atHead = await client.getCode({ address: factory, blockNumber: high });
  if (!atHead || atHead === "0x") {
    resolvedStarts.set(deployment.chain, high);
    return high;
  }

  while (low + 1n < high) {
    const mid = (low + high) / 2n;
    const code = await client.getCode({ address: factory, blockNumber: mid });
    if (code && code !== "0x") high = mid;
    else low = mid;
  }

  resolvedStarts.set(deployment.chain, high);
  return high;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
