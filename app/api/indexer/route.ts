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
    if (header !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    console.error("Indexer run failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

/** Same work, for callers that would rather POST — a webhook, usually. */
export const POST = GET;
