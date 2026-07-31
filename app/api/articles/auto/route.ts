import { NextResponse } from "next/server";
import { draftArticle } from "@/lib/ai/writer";
import { isTopic, TOPICS, type Topic } from "@/lib/ai/news";
import { isAgentConfigured, NoProviderError } from "@/lib/ai/provider";
import { publishPost, PublishError } from "@/lib/ai/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * `POST /api/articles/auto` — the article desk, running unattended.
 *
 * Drafts and publishes in one call, with nobody reading it in between. That is
 * the difference between this and the composer, and the reason it is behind a
 * secret rather than a rate limit: an endpoint that publishes to the front page
 * without review must not be callable by whoever finds the URL.
 *
 *   ARTICLE_AGENT_SECRET  required. Sent as `Authorization: Bearer <secret>`,
 *                         or `?key=<secret>` for schedulers that cannot set a
 *                         header. Unset, this endpoint refuses every request —
 *                         it does not fall open the way /api/indexer does,
 *                         because that one only mirrors facts already on chain
 *                         and this one writes new pages.
 *
 * Wire it to a scheduler:
 *
 *   Vercel Cron  — vercel.json:
 *                  { "crons": [{ "path": "/api/articles/auto?topic=rotate",
 *                                "schedule": "0 7 * * *" }] }
 *                  Vercel sends its own Authorization header on cron requests,
 *                  so pass the secret in the query string there.
 *   GitHub Actions / cron / anything that can curl.
 *
 * `?topic=` takes a topic, a comma-separated list, `rotate` (the default — one
 * topic per day, cycled by day of year so a daily schedule covers all three
 * evenly) or `all` (one article per topic, in one run).
 *
 * The response reports per topic. One topic failing does not stop the others:
 * a crypto feed being down should not cost the AI article too.
 */
export async function POST(request: Request) {
  const secret = process.env.ARTICLE_AGENT_SECRET;
  if (!secret) {
    return NextResponse.json(
      {
        error:
          "ARTICLE_AGENT_SECRET is not set. The unattended agent stays off until it is — see .env.example.",
      },
      { status: 503 }
    );
  }

  const url = new URL(request.url);
  const presented =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("key");
  if (presented !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isAgentConfigured()) {
    return NextResponse.json(
      { error: "No model is configured. Set GROQ_API_KEY or GEMINI_API_KEY." },
      { status: 503 }
    );
  }

  const topics = resolveTopics(url.searchParams.get("topic"));
  if (topics.length === 0) {
    return NextResponse.json(
      { error: `Unknown topic. Use one of ${TOPICS.join(", ")}, or "rotate", or "all".` },
      { status: 400 }
    );
  }

  const angle = url.searchParams.get("angle") ?? undefined;
  const results: Array<Record<string, unknown>> = [];

  // Sequential on purpose. Three generations at once is three times the burst
  // against a free-tier rate limit, and the run is a cron job — it has the time.
  for (const topic of topics) {
    try {
      const draft = await draftArticle({ topic, angle });
      const post = await publishPost({
        title: draft.title,
        slug: draft.slug,
        excerpt: draft.excerpt,
        body: draft.bodyHtml,
        topic: draft.topic,
        tags: draft.tags,
        sources: draft.sources,
        model: draft.model,
      });
      results.push({
        topic,
        ok: true,
        slug: post.slug,
        title: post.title,
        path: `/read/${post.slug}`,
        model: draft.model,
        // Present when the primary provider refused and the fallback wrote it.
        // A run that has quietly been on Gemini for a week is worth seeing.
        ...(draft.fallbacks.length ? { fallbacks: draft.fallbacks } : {}),
      });
    } catch (err) {
      console.error(`Unattended article run failed for ${topic}:`, err);
      results.push({
        topic,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof NoProviderError ? { attempts: err.attempts } : {}),
        ...(err instanceof PublishError ? { status: err.status } : {}),
      });
    }
  }

  const published = results.filter((result) => result.ok).length;
  return NextResponse.json(
    { published, attempted: results.length, results },
    // Nothing published is a failure worth a non-2xx, so a cron monitor alerts
    // instead of reporting a green run that wrote nothing.
    { status: published > 0 ? 200 : 502 }
  );
}

/** Same work, for schedulers that only issue GETs. */
export const GET = POST;

function resolveTopics(value: string | null): Topic[] {
  const raw = (value ?? "rotate").trim().toLowerCase();

  if (raw === "all") return [...TOPICS];
  if (raw === "rotate") {
    const dayOfYear = Math.floor(
      (Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 0)) / 86_400_000
    );
    return [TOPICS[dayOfYear % TOPICS.length]!];
  }

  return raw
    .split(",")
    .map((topic) => topic.trim())
    .filter(isTopic);
}
