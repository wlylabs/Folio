import { serverSupabase, hasServiceRole } from "@/lib/supabaseAdmin";
import { sanitizeArticleHtml, articleExcerpt } from "@/lib/sanitize";
import { META_DESCRIPTION_LENGTH } from "@/lib/seo";
import { isTopic } from "./news";
import { slugify, type DraftSource } from "./writer";

/**
 * Writing a post to the database — the one place that does, for both the
 * composer and the scheduled agent.
 *
 * Everything arriving here is treated as untrusted, including the draft the
 * agent itself produced a moment ago. The composer round-trips a draft through
 * the browser so a person can edit it before publishing, which means the body
 * that comes back is whatever the browser sent — sanitizing it again on the way
 * in costs nothing and closes the hole that assumption would open. Sources are
 * checked the same way: they are the post's evidence, and a post publishes with
 * none only over this function's objection.
 */

/** Matches the RLS-free reality of this table: a bad row is one we wrote. */
const MAX_BODY_LENGTH = 100_000;

export type PublishInput = {
  title: string;
  slug?: string;
  excerpt?: string;
  body: string;
  topic: string;
  tags?: unknown;
  sources?: unknown;
  model?: string | null;
  authorWallet?: string | null;
};

export type PublishedPost = { slug: string; title: string };

/** Thrown for anything the caller could fix by sending different input. */
export class PublishError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublishError";
    this.status = status;
  }
}

export async function publishPost(input: PublishInput): Promise<PublishedPost> {
  // The service role is what writes here; the anon key has select and nothing
  // else on `posts` (lib/schema.sql). Falling back to it would fail inside
  // PostgREST with a policy error that says nothing about the missing key, so
  // this checks first and says what to set.
  if (!hasServiceRole) {
    throw new PublishError(
      "Publishing an article needs SUPABASE_SERVICE_ROLE_KEY. The `posts` table has no insert policy for the public key — see lib/schema.sql.",
      503
    );
  }

  const client = serverSupabase();
  if (!client) {
    throw new PublishError("Supabase is not configured. See .env.example.", 503);
  }

  const title = input.title?.trim() ?? "";
  if (!title) throw new PublishError("An article needs a headline.");
  if (title.length > 200) throw new PublishError("Keep the headline under 200 characters.");

  if (!isTopic(input.topic)) {
    throw new PublishError(`Unknown topic "${input.topic}". Use ai, technology or crypto.`);
  }

  const body = sanitizeArticleHtml(input.body);
  if (!body.trim()) throw new PublishError("The article body is empty.");
  if (body.length > MAX_BODY_LENGTH) {
    throw new PublishError("The article body is too long to publish.");
  }

  const sources = normaliseSources(input.sources);
  if (sources.length === 0) {
    throw new PublishError(
      "An article must cite at least one source. Regenerate the draft rather than publishing it unattributed."
    );
  }

  const excerpt = input.excerpt?.trim()
    ? input.excerpt.trim().slice(0, META_DESCRIPTION_LENGTH)
    : articleExcerpt(body, META_DESCRIPTION_LENGTH);

  const slug = await uniqueSlug(client, slugify(input.slug?.trim() || title));

  const { error } = await client.from("posts").insert({
    slug,
    title,
    excerpt,
    body,
    topic: input.topic,
    tags: normaliseTags(input.tags),
    sources,
    model: input.model?.trim() || null,
    author_wallet: normaliseWallet(input.authorWallet),
  });

  if (error) {
    // A unique violation here means another publish took the slug between the
    // check and the insert. It is rare enough to report rather than retry —
    // the caller still holds the draft, and a second press succeeds.
    if (error.code === "23505") {
      throw new PublishError("That slug was just taken. Publish again to get the next one.", 409);
    }
    throw new PublishError(`Saving the article failed: ${error.message}`, 500);
  }

  return { slug, title };
}

/**
 * A slug nothing else is using.
 *
 * Two posts about the same day's news genuinely do produce the same slug, so
 * the collision is expected rather than exceptional. The suffix is a counter
 * and not a timestamp: `-2` reads like a second article on a subject, which is
 * what it is, where `-lq4h2` reads like a database key leaking into a URL.
 */
async function uniqueSlug(
  client: NonNullable<ReturnType<typeof serverSupabase>>,
  base: string
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const { data, error } = await client
      .from("posts")
      .select("slug")
      .eq("slug", candidate)
      .maybeSingle();

    // A failed lookup must not silently hand back a slug that may be taken;
    // the insert's unique constraint is the backstop either way.
    if (error) throw new PublishError(`Could not check the slug: ${error.message}`, 500);
    if (!data) return candidate;
  }
  throw new PublishError("Could not find a free slug for that headline.", 409);
}

/**
 * Sources, filtered to the ones that are actually citations.
 *
 * A source is a link a reader can follow, so anything without an http(s) URL is
 * dropped rather than stored — a "source" that cannot be opened is decoration,
 * and the whole point of the column is that the post can show its work.
 */
function normaliseSources(value: unknown): DraftSource[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const sources: DraftSource[] = [];

  for (const entry of value.slice(0, 12)) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as Record<string, unknown>;
    const url = typeof source.url === "string" ? source.url.trim() : "";
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;

    seen.add(url);
    sources.push({
      title: str(source.title).slice(0, 300) || url,
      url,
      publisher: str(source.publisher).slice(0, 120) || hostname(url),
      published_at: str(source.published_at) || null,
    });
  }

  return sources;
}

function normaliseTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = value
    .map((tag) => str(tag).toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim())
    .filter((tag) => tag.length > 1 && tag.length <= 32);
  return [...new Set(tags)].slice(0, 6);
}

/**
 * The editor's wallet, if one was connected.
 *
 * Stored lowercased and only when it looks like an address. It is a claim and
 * not a proof — the same caveat `tokens.creator_wallet` carries — so it is
 * recorded, never trusted, and never the byline: the byline names the model.
 */
function normaliseWallet(value: string | null | undefined): string | null {
  const wallet = value?.trim().toLowerCase() ?? "";
  return /^0x[0-9a-f]{40}$/.test(wallet) ? wallet : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
