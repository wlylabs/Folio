import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { syncLaunches } from "@/lib/indexer";
import { hasServiceRole } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The launch indexer, as an endpoint.
 *
 * `GET /api/indexer` scans every configured factory's `TokenCreated` log — one
 * per chain — and writes a listing for anything the table is missing. It is
 * idempotent, so it is safe to call on a schedule, from a deploy hook, or by
 * hand. The response carries a per-chain breakdown under `chains`; a chain
 * whose RPC is down reports itself there without stopping the others.
 *
 * Wire it to whichever of these you have:
 *
 *   Vercel Cron   — add to vercel.json:
 *                   { "crons": [{ "path": "/api/indexer", "schedule": "*\/5 * * * *" }] }
 *                   (Hobby projects are limited to one run a day; a Pro project
 *                   can run it every few minutes.)
 *   A watcher     — `npm run watch:launches` subscribes to the event and calls
 *                   this the moment a launch lands, which is as close to
 *                   real-time as this design gets.
 *   By hand       — curl it after creating a token from a Foundry script.
 *
 * Set `INDEXER_SECRET` to require `Authorization: Bearer <secret>`. Without it
 * the endpoint is open, which is tolerable — the worst a caller can do is make
 * the server read its own chain and insert rows that the log says exist — but on
 * anything public it should be set, because an unauthenticated endpoint that
 * makes dozens of RPC calls is a free way to burn someone else's rate limit.
 *
 * `?from=<block>` forces a rescan from a given block, for when a row was deleted
 * by hand and needs to come back. `?chain=<slug>` limits the run to one chain —
 * which is what makes `from` usable with more than one configured, since a
 * block number only means anything on the chain it came from.
 */
export async function GET(request: Request) {
  const secret = process.env.INDEXER_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (!matchesSecret(header, `Bearer ${secret}`)) {
      return NextResponse.json(
        { error: "Unauthorized" },
        // A 401 that a CDN is free to cache is a 401 served to the next caller
        // who does hold the secret.
        { status: 401, headers: { "cache-control": "no-store" } }
      );
    }
  }

  const params = new URL(request.url).searchParams;
  const from = params.get("from");
  const chain = params.get("chain");

  try {
    const result = await syncLaunches({
      ...(from && /^\d+$/.test(from) ? { fromBlock: BigInt(from) } : {}),
      ...(chain ? { chain } : {}),
    });

    return NextResponse.json(
      { ...result, serviceRole: hasServiceRole },
      // A partial run still reports what it wrote, but it is not a success.
      { status: result.error ? 500 : 200 }
    );
  } catch (err) {
    // The detail goes to the log, which the operator can read, rather than
    // into the response, which anyone can. A thrown RPC or Postgres error
    // carries endpoints, table names and occasionally a URL with a key in it.
    console.error("Indexer run failed:", err);
    return NextResponse.json(
      { error: "The indexer run failed. See the server log for the reason." },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}

/** Same work, for callers that would rather POST — a webhook, usually. */
export const POST = GET;

/**
 * Whether a presented credential is the expected one, in time that does not
 * depend on how much of it was right.
 *
 * `===` on two strings stops at the first byte that differs, and the time it
 * took to stop is a measurement an attacker can make — repeatedly, from a
 * network they control, one byte at a time. It is a slow attack and a real
 * one, and the fix is a comparison that always reads both values to the end.
 *
 * The hash is what makes that possible: `timingSafeEqual` throws on inputs of
 * different lengths, and refusing early on a length mismatch would leak the
 * length. Two SHA-256 digests are always 32 bytes, whatever went into them.
 */
function matchesSecret(presented: string | null, expected: string): boolean {
  if (!presented) return false;

  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
