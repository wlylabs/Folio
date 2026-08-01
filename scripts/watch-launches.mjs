/**
 * Watches every factory for `TokenCreated` and tells the site to index it.
 *
 *   npm run watch:launches
 *
 * This is the "listen for the event" half of the indexer. It holds one
 * subscription open per chain that has a deployment record — a real one over a
 * websocket RPC, or viem's block-polling fallback over HTTP — and calls
 * `/api/indexer` whenever a launch lands, so a token created from a Foundry
 * script or straight from the explorer shows up in the feed within seconds
 * rather than whenever the next cron fires.
 *
 * It deliberately does not write to the database itself. There is exactly one
 * path from a log to a row (lib/indexer.ts), and this process is a trigger for
 * it, not a second implementation of it.
 *
 * Configuration, all optional:
 *
 *   FOLIO_SITE_URL   where the site is running. Default http://localhost:3000
 *   FOLIO_WS_RPC     a websocket RPC (wss://…) for a real subscription. Applies
 *                    to the one chain being watched; with several, use the
 *                    per-chain form below.
 *   FOLIO_WS_RPC_<CHAIN>          e.g. FOLIO_WS_RPC_ROBINHOOD_MAINNET
 *   NEXT_PUBLIC_RPC_<CHAIN>       the same HTTP endpoints the site reads with,
 *                                 e.g. NEXT_PUBLIC_RPC_ROBINHOOD_MAINNET
 *   INDEXER_SECRET   sent as a bearer token, when the endpoint requires one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbiItem, webSocket } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentsDir = join(root, "deployments");

/**
 * The public endpoints to fall back on, per chain slug.
 *
 * Kept here rather than read from the records because a deployment record says
 * where the factory is, not how to reach the chain — and this script cannot
 * import lib/chains.ts, which is TypeScript the site compiles and Node does
 * not. Rate-limited, which is exactly why NEXT_PUBLIC_RPC_* exists.
 */
const PUBLIC_RPC = {
  "robinhood-mainnet": "https://rpc.mainnet.chain.robinhood.com",
};

/** `robinhood-mainnet` -> `ROBINHOOD_MAINNET`, for the env var names. */
const envKey = (slug) => slug.toUpperCase().replace(/-/g, "_");

/** Every committed record that names a factory. */
function readDeployments() {
  return readdirSync(deploymentsDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const slug = file.replace(/\.json$/, "");
      const record = JSON.parse(readFileSync(join(deploymentsDir, file), "utf8"));
      return { slug, factory: record.factory, name: record.network || slug };
    })
    .filter((d) => /^0x[0-9a-fA-F]{40}$/.test(d.factory ?? ""));
}

const deployments = readDeployments();

if (deployments.length === 0) {
  console.error(
    "No factory address in any deployments/*.json. Deploy one first — see DEPLOYMENT.md."
  );
  process.exit(1);
}

const siteUrl = (process.env.FOLIO_SITE_URL || "http://localhost:3000").replace(/\/$/, "");

/**
 * The endpoint for one chain: its websocket if one is configured, then its HTTP
 * endpoint, then the public one with polling.
 *
 * The bare FOLIO_WS_RPC is only honoured when there is a single chain to watch.
 * With more than one it would point every subscription at whichever chain that
 * URL belongs to, and the other watchers would sit on the wrong log reporting
 * nothing — a failure that looks exactly like a quiet week.
 */
function endpointFor(slug) {
  const key = envKey(slug);
  const ws =
    process.env[`FOLIO_WS_RPC_${key}`] ||
    (deployments.length === 1 ? process.env.FOLIO_WS_RPC : "") ||
    "";
  if (ws.startsWith("ws")) return { url: ws, websocket: true };

  return { url: process.env[`NEXT_PUBLIC_RPC_${key}`] || "", websocket: false };
}

/**
 * The trailing tuple is `CurveConfig`, and it has to match the struct exactly.
 *
 * Adding a field to `contracts/src/types/CurveConfig.sol` changes this event's
 * signature and so its topic0, at which point a stale copy here matches nothing
 * and this watcher goes quiet without erroring — the worst failure shape
 * available. `lib/indexer.ts` avoids the problem by reading the generated ABI;
 * this is a plain `.mjs` and cannot import the TypeScript module, so the string
 * is maintained by hand and this comment is the reminder that it must be.
 */
const TOKEN_CREATED = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 totalSupply, (uint256 virtualEthReserve, uint256 maxReserveCap, uint256 graduationThreshold, uint16 feeBps, uint16 priceMoveAlertBps, uint16 sniperWindowSeconds, uint256 sniperMaxEthPerWallet, address migrator) config)"
);

/**
 * Ask the site to reconcile its table against the chain.
 *
 * `chain` narrows the scan to the one that just fired, so a launch on one
 * network doesn't send the indexer back through every other network's log.
 * Omitted for the startup sweep, which is meant to cover everything.
 */
async function index(reason, chain) {
  const headers = process.env.INDEXER_SECRET
    ? { authorization: `Bearer ${process.env.INDEXER_SECRET}` }
    : undefined;

  const url = `${siteUrl}/api/indexer${chain ? `?chain=${encodeURIComponent(chain)}` : ""}`;

  try {
    const response = await fetch(url, { method: "POST", headers });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(`[${stamp()}] ${reason}: indexer returned ${response.status}`, body);
      return;
    }
    console.log(
      `[${stamp()}] ${reason}: ${body.found ?? 0} launch(es) in log, ${body.inserted ?? 0} newly listed`
    );
  } catch (err) {
    // The site being down is not a reason to lose the subscription — the next
    // event, or the next restart, reconciles everything from the log anyway.
    console.error(`[${stamp()}] ${reason}: could not reach ${siteUrl}`, err.message);
  }
}

function stamp() {
  return new Date().toISOString().slice(11, 19);
}

console.log(`Site      : ${siteUrl}`);
for (const { slug, factory, name } of deployments) {
  const { url, websocket } = endpointFor(slug);
  console.log(
    `Watching  : ${factory} on ${name} (${
      websocket ? `websocket ${url}` : `http polling ${url || "public endpoint"}`
    })`
  );
}

// Catch up on anything that happened while nothing was watching, then follow.
await index("startup sweep");

const unwatchers = deployments.map(({ slug, factory, name }) => {
  const { url, websocket } = endpointFor(slug);

  // No `chain` on the client: viem only needs one to fill in a default RPC and
  // to validate a chain id before signing, and this process does neither. That
  // is also what keeps the script working for a chain viem has never heard of.
  const client = createPublicClient({
    transport: websocket ? webSocket(url) : http(url || PUBLIC_RPC[slug] || undefined),
  });

  return client.watchEvent({
    address: factory,
    event: TOKEN_CREATED,
    onLogs: (logs) => {
      for (const log of logs) {
        console.log(`[${stamp()}] ${name}: TokenCreated ${log.args.token} (${log.args.symbol})`);
      }
      void index(`${name}: ${logs.length} event(s)`, slug);
    },
    onError: (err) => console.error(`[${stamp()}] ${name}: subscription error:`, err.message),
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const unwatch of unwatchers) unwatch();
    console.log("\nStopped watching.");
    process.exit(0);
  });
}
