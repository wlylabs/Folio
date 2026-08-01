import { NextResponse } from "next/server";
import { chainBySlug, isChainSlug } from "@/lib/chains";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A read-only JSON-RPC relay on Folio's own origin.
 *
 * `POST /api/rpc/<slug>` takes a JSON-RPC request, forwards it to the chain's
 * endpoint from the server, and hands the answer straight back. Nothing is
 * interpreted and nothing is cached: this is a piece of plumbing, not an API.
 *
 * It exists because "the browser can load Folio" and "the browser can reach
 * Robinhood Chain's RPC" are two different claims, and the second one fails on
 * its own for reasons the first never sees. A mobile network that filters the
 * RPC's domain, an in-app browser whose WebView is handed a truncated DNS or
 * proxy configuration, a captive middlebox answering a POST with an HTML block
 * page, a CDN in front of the endpoint challenging a request that carries no
 * cookie jar — every one of those is invisible from a server and total from the
 * phone. What the reader sees is `unreadable` in useGasBalance and the "Balance
 * unavailable" notice, on a wallet with ETH in it, permanently, however many
 * times they press re-check. The page loaded, so the request that goes back to
 * the same host it loaded from is the one request known to work.
 *
 * So `lib/wagmiConfig.ts` puts this behind the direct endpoint in a viem
 * `fallback`: reads go straight to the RPC as they always did, and only a
 * browser that cannot get there itself ends up here. A working network never
 * touches this route.
 *
 * Being read-only is what makes it safe to leave open. `ALLOWED` is the set of
 * methods the app's own reads use; anything else — `eth_sendRawTransaction`
 * above all — is refused. Wallets broadcast through their own provider and
 * never through this, so refusing writes costs Folio nothing and means a
 * stranger who finds this URL cannot use it to push transactions or spend an
 * endpoint's write quota. It is still an open relay for reads: the origin check
 * below only keeps other *websites* from scripting it.
 *
 * Three limits keep that openness from being worth exploiting — an allowlist of
 * read methods, a cap on how large a body may be, and a per-caller count for
 * the minute. All three are described where they are defined. None of them is a
 * substitute for rate limiting at the edge, which is the only place a request
 * can be refused before it costs anything to receive.
 */

/**
 * The JSON-RPC methods this will forward.
 *
 * Every one of them is a read. The list is what viem and wagmi actually ask for
 * across the app — balances and the gas notice, contract reads for curve
 * figures, the fee estimates in a launch, `waitForTransactionReceipt`'s block
 * polling, and the client-side log scan that finds a new token's address — plus
 * the two identity calls a transport makes on its own. A method that is missing
 * shows up as a single refused request in a console, which is a better failure
 * than a proxy that will forward anything.
 */
const ALLOWED = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByHash",
  "eth_getBlockByNumber",
  "eth_getBlockReceipts",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "net_version",
  "web3_clientVersion",
]);

/**
 * How many calls one batch may carry.
 *
 * viem batches nothing by default, so anything Folio sends arrives alone. The
 * cap is here for what someone else might send.
 */
const MAX_BATCH = 20;

/**
 * How large a request body may be before it is refused, unread.
 *
 * A JSON-RPC read is small — the largest thing Folio sends is an `eth_call`
 * carrying calldata, which is hundreds of bytes. Without a cap, `request.json()`
 * will happily buffer whatever arrives, and "whatever arrives" is chosen by
 * whoever found this URL. 64 KiB is orders of magnitude above any real call and
 * far below anything worth calling an attack.
 *
 * The check is on the stream rather than on `content-length`, because a header
 * is a claim and the body is the fact.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Requests one address may make, and the window they are counted over.
 *
 * This is a courtesy limit, not a security boundary, and the difference matters:
 * the counter lives in one server instance's memory, so a platform running
 * several of them enforces this several times over, and a cold start forgets
 * everything. What it does do is stop a single script from turning Folio's
 * origin into a free, unmetered front end for someone else's RPC quota — which
 * is the realistic abuse of a relay that answers reads to anyone.
 *
 * Real rate limiting belongs at the edge, where the request has not yet cost a
 * function invocation. This is what is available from inside the function.
 */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

/** Callers seen in the current window, and how many calls each has made. */
const seen = new Map<string, { count: number; resetAt: number }>();

/**
 * Callers tracked at once. The map is process-wide and lives as long as the
 * instance, so it evicts rather than growing — an address that falls off the
 * end simply starts a fresh window, which is the harmless direction to fail.
 */
const MAX_TRACKED = 5_000;

/** Upstream is allowed this long before we give up on it. */
const TIMEOUT_MS = 12_000;

/** JSON-RPC's own "internal error", for the failures that happen on this side. */
const INTERNAL_ERROR = -32603;

export async function POST(request: Request, { params }: { params: { slug: string } }) {
  if (!isChainSlug(params.slug)) {
    return rpcError(-32601, "Unknown chain.", 404);
  }

  /**
   * Other sites are not welcome to script this.
   *
   * A browser sends `Origin` on every cross-origin POST, so a page on someone
   * else's domain that points a viem client at this route identifies itself
   * here. Folio's own reads send this host and pass; a request with no `Origin`
   * at all — curl, a server — is let through, because refusing it would only
   * teach the next one to omit the header. This narrows the abuse, it does not
   * close it, which is the other half of why `ALLOWED` holds no writes.
   *
   * Matched against the request's own host rather than a configured site URL,
   * so preview deploys and localhost work without naming every hostname.
   */
  const origin = request.headers.get("origin");
  if (origin && !sameOrigin(origin, request.headers.get("host"))) {
    return rpcError(-32600, "Cross-origin requests are not accepted here.", 403);
  }

  if (rateLimited(request)) {
    return rpcError(-32005, "Too many requests to this relay. Try again shortly.", 429);
  }

  const raw = await readCapped(request.body, MAX_BODY_BYTES);
  if (raw === null) {
    return rpcError(-32600, "Request body is too large for this relay.", 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return rpcError(-32700, "Body is not JSON.", 400);
  }

  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH) {
    return rpcError(-32600, `A batch carries between 1 and ${MAX_BATCH} calls.`, 400);
  }

  for (const call of calls) {
    const method = (call as { method?: unknown } | null)?.method;
    if (typeof method !== "string") {
      return rpcError(-32600, "Every call needs a method.", 400);
    }
    if (!ALLOWED.has(method)) {
      // 200, because this is the JSON-RPC layer's answer rather than HTTP's:
      // viem reads the error object and reports the method by name, where a 403
      // would surface as a transport failure with nothing in it to act on.
      return rpcError(-32601, `${method} is not forwarded by this relay.`, 200);
    }
  }

  const entry = chainBySlug(params.slug);
  const upstream = entry?.rpcEnv || entry?.chain.rpcUrls.default.http[0];
  if (!upstream) {
    return rpcError(INTERNAL_ERROR, "No endpoint is configured for this chain.", 500);
  }

  try {
    const response = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    // Passed through as text: a JSON-RPC error is a perfectly ordinary answer
    // and viem knows what to do with it, so re-encoding would only lose detail.
    // The status travels with it for the same reason — a 429 upstream should
    // read as a 429 here, not as a success carrying an error object.
    const text = await response.text();

    return new NextResponse(text, {
      status: response.ok ? 200 : response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error(`RPC relay to ${params.slug} failed:`, err);
    return rpcError(INTERNAL_ERROR, "The chain's RPC did not answer.", 502);
  }
}

/**
 * A JSON-RPC error object, shaped so viem reports it rather than choking on it.
 *
 * `id: null` is what the spec asks for when the request the error is about
 * could not be read — and when it could, viem matches on the method it sent
 * rather than on the id, so a null costs nothing there either.
 */
function rpcError(code: number, message: string, status: number) {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers: { "cache-control": "no-store" } }
  );
}

/**
 * The body as text, or null if it is larger than the cap.
 *
 * Read a chunk at a time so an oversized body is refused while it is still
 * being sent, rather than after it has all been held in memory. The stream is
 * cancelled on the way out, which is what tells the client to stop.
 */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number
): Promise<string | null> {
  if (!body) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Whether this caller has had its allowance for the minute.
 *
 * The address comes from `x-forwarded-for`, which is a header and therefore a
 * claim — anyone can send one. That is fine for what this is: the leftmost
 * entry is written by the platform's own proxy in front of this code, and a
 * caller who forges it only ever moves themselves into a different bucket. It
 * is not an identity, and nothing but this counter treats it as one.
 */
function rateLimited(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-for");
  const caller = forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";

  const now = Date.now();
  const entry = seen.get(caller);

  if (!entry || now > entry.resetAt) {
    if (seen.size >= MAX_TRACKED) {
      // Oldest insertion first, which is close enough to oldest window.
      const oldest = seen.keys().next();
      if (!oldest.done) seen.delete(oldest.value);
    }
    seen.set(caller, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

/** Whether an `Origin` header names the same host this request arrived on. */
function sameOrigin(origin: string, host: string | null): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
