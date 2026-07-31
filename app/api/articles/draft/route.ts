import { NextResponse } from "next/server";
import { draftArticle } from "@/lib/ai/writer";
import { isTopic, NoFeedError } from "@/lib/ai/news";
import { NoFreshNewsError } from "@/lib/ai/history";
import { isAgentConfigured, NoProviderError } from "@/lib/ai/provider";
import { deskDenial } from "@/lib/desk";
import { callerKey, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `POST /api/articles/draft` — the article agent, writing but not publishing.
 *
 * Body: `{ topic: "ai" | "technology" | "crypto", angle?: string }`.
 *
 * Reads the topic's feeds, writes a piece from what they syndicated, and
 * returns the draft for review. Nothing is stored: the composer loads the body
 * into an editor so a person reads it before it becomes a page, and
 * /api/articles/publish is the step that writes.
 *
 * Desk only. Every call spends a model quota on somebody else's key, so an
 * unlocked session (lib/desk.ts) is checked before anything else — ahead of the
 * rate limit, which exists to catch a loop rather than a stranger.
 *
 * The generation runs to a minute on a slow fallback, which is inside Vercel's
 * default function timeout on a Pro plan and outside the ten seconds a Hobby
 * plan allows — a Hobby deployment should set `maxDuration` or expect the
 * occasional 504 when Groq is rate limited and Gemini has to answer instead.
 */
export const maxDuration = 90;

/** Generous for one writer, ruinous for a loop. See lib/rateLimit.ts. */
const LIMIT = Number(process.env.ARTICLE_AGENT_RATE_LIMIT || 8);
const WINDOW_MS = 60 * 60_000;

export async function POST(request: Request) {
  const denial = deskDenial(request);
  if (denial) {
    return NextResponse.json({ error: denial.error }, { status: denial.status });
  }

  if (!isAgentConfigured()) {
    return NextResponse.json(
      {
        error:
          "The article agent has no model to call. Set GROQ_API_KEY, or GEMINI_API_KEY, or both — see .env.example.",
      },
      { status: 503 }
    );
  }

  const limit = rateLimit(`draft:${callerKey(request)}`, LIMIT, WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `That's ${LIMIT} drafts this hour. Try again in ${limit.retryAfter}s.` },
      { status: 429, headers: { "retry-after": String(limit.retryAfter) } }
    );
  }

  let payload: { topic?: unknown; angle?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!isTopic(payload.topic)) {
    return NextResponse.json(
      { error: 'Pick a topic: "ai", "technology" or "crypto".' },
      { status: 400 }
    );
  }

  try {
    const draft = await draftArticle({
      topic: payload.topic,
      angle: typeof payload.angle === "string" ? payload.angle : undefined,
    });
    return NextResponse.json({ draft, remaining: limit.remaining });
  } catch (err) {
    // A beat with nothing new in it is not an error in the server, so it is not
    // logged as one. 409: the request was fine and the state of the world is
    // what refused it.
    if (err instanceof NoFreshNewsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("Article draft failed:", err);

    // Every provider refusing, or every feed refusing, is something upstream
    // failing rather than a bad request — 502 says "the thing behind me
    // failed" and keeps the composer from telling the writer they typed
    // something wrong. A 500 is left for the cases that really are our bug.
    const status = err instanceof NoProviderError || err instanceof NoFeedError ? 502 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The article agent failed." },
      { status }
    );
  }
}
