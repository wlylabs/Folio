import { NextResponse } from "next/server";
import { publishPost, PublishError } from "@/lib/ai/publish";
import { deskDenial } from "@/lib/desk";
import { postfolioPath } from "@/lib/postfolio";
import { callerKey, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `POST /api/articles/publish` — turn a reviewed draft into a page.
 *
 * Body: the draft the composer holds, plus the connected wallet if there is
 * one:
 *
 *   { title, slug?, excerpt?, body, topic, tags?, sources?, model?, authorWallet? }
 *
 * Desk only, and this is the endpoint that most needs to be: it puts HTML on
 * the front page for free, with no signature and no gas to price the abuse. A
 * rate limit alone was never authorisation — it decided how fast a stranger
 * could fill the feed, not whether they could. An unlocked desk session
 * (lib/desk.ts) is now the answer, and the launchpad is the door for everyone
 * else: a listing there costs a transaction, which is the whole point.
 *
 * The write needs the service role, because `posts` has no insert policy for
 * the public key — publishing here costs no gas and no signature, so an open
 * insert policy would be an open invitation to fill the feed. A deployment
 * without SUPABASE_SERVICE_ROLE_KEY gets a 503 that says exactly that.
 *
 * Everything in the body is re-validated and re-sanitized by {publishPost}: the
 * draft went through a browser to get here, so what comes back is user input
 * whatever produced it.
 */

const LIMIT = Number(process.env.ARTICLE_PUBLISH_RATE_LIMIT || 12);
const WINDOW_MS = 60 * 60_000;

export async function POST(request: Request) {
  const denial = deskDenial(request);
  if (denial) {
    return NextResponse.json({ error: denial.error }, { status: denial.status });
  }

  const limit = rateLimit(`publish:${callerKey(request)}`, LIMIT, WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `That's ${LIMIT} articles this hour. Try again in ${limit.retryAfter}s.` },
      { status: 429, headers: { "retry-after": String(limit.retryAfter) } }
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const post = await publishPost({
      title: String(payload.title ?? ""),
      slug: typeof payload.slug === "string" ? payload.slug : undefined,
      excerpt: typeof payload.excerpt === "string" ? payload.excerpt : undefined,
      body: String(payload.body ?? ""),
      topic: String(payload.topic ?? ""),
      tags: payload.tags,
      sources: payload.sources,
      model: typeof payload.model === "string" ? payload.model : null,
      authorWallet: typeof payload.authorWallet === "string" ? payload.authorWallet : null,
    });

    return NextResponse.json({ ...post, path: postfolioPath(post.slug) }, { status: 201 });
  } catch (err) {
    if (err instanceof PublishError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("Publishing an article failed:", err);
    return NextResponse.json({ error: "Publishing the article failed." }, { status: 500 });
  }
}
