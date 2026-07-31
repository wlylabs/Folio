/**
 * Watches the factory for `TokenCreated` and tells the site to index it.
 *
 *   npm run watch:launches
 *
 * This is the "listen for the event" half of the indexer. It holds a
 * subscription open — a real one over a websocket RPC, or viem's block-polling
 * fallback over HTTP — and calls `/api/indexer` whenever a launch lands, so a
 * token created from a Foundry script or straight from the explorer shows up in
 * the feed within seconds rather than whenever the next cron fires.
 *
 * It deliberately does not write to the database itself. There is exactly one
 * path from a log to a row (lib/indexer.ts), and this process is a trigger for
 * it, not a second implementation of it.
 *
 * Configuration, all optional:
 *
 *   FOLIO_SITE_URL   where the site is running. Default http://localhost:3000
 *   FOLIO_WS_RPC     a websocket RPC (wss://…) for a real subscription.
 *                    Falls back to NEXT_PUBLIC_RPC_BASE_SEPOLIA, then to the
 *                    public HTTP endpoint with polling.
 *   INDEXER_SECRET   sent as a bearer token, when the endpoint requires one.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbiItem, webSocket } from "viem";
import { baseSepolia } from "viem/chains";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(
  readFileSync(join(root, "deployments", "base-sepolia.json"), "utf8")
);

const factory = deployment.factory;
if (!/^0x[0-9a-fA-F]{40}$/.test(factory ?? "")) {
  console.error("No factory address in deployments/base-sepolia.json. Deploy one first.");
  process.exit(1);
}

const siteUrl = (process.env.FOLIO_SITE_URL || "http://localhost:3000").replace(/\/$/, "");
const rpcUrl = process.env.FOLIO_WS_RPC || process.env.NEXT_PUBLIC_RPC_BASE_SEPOLIA || "";
const usingWebsocket = rpcUrl.startsWith("ws");

const client = createPublicClient({
  chain: baseSepolia,
  transport: usingWebsocket ? webSocket(rpcUrl) : http(rpcUrl || undefined),
});

const TOKEN_CREATED = parseAbiItem(
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 totalSupply, (uint256 virtualEthReserve, uint256 maxReserveCap, uint256 graduationThreshold, uint16 feeBps, uint16 priceMoveAlertBps) config)"
);

/** Ask the site to reconcile its table against the chain. */
async function index(reason) {
  const headers = process.env.INDEXER_SECRET
    ? { authorization: `Bearer ${process.env.INDEXER_SECRET}` }
    : undefined;

  try {
    const response = await fetch(`${siteUrl}/api/indexer`, { method: "POST", headers });
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

console.log(`Watching ${factory} on ${baseSepolia.name}`);
console.log(`  transport : ${usingWebsocket ? `websocket ${rpcUrl}` : `http polling ${rpcUrl || "(public endpoint)"}`}`);
console.log(`  site      : ${siteUrl}`);

// Catch up on anything that happened while nothing was watching, then follow.
await index("startup sweep");

const unwatch = client.watchEvent({
  address: factory,
  event: TOKEN_CREATED,
  onLogs: (logs) => {
    for (const log of logs) {
      console.log(`[${stamp()}] TokenCreated ${log.args.token} (${log.args.symbol})`);
    }
    void index(`${logs.length} event(s)`);
  },
  onError: (err) => console.error(`[${stamp()}] subscription error:`, err.message),
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    unwatch();
    console.log("\nStopped watching.");
    process.exit(0);
  });
}
