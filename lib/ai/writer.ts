import { marked } from "marked";
import { sanitizeArticleHtml, articleExcerpt } from "@/lib/sanitize";
import { META_DESCRIPTION_LENGTH } from "@/lib/seo";
import { complete, type ProviderName } from "./provider";
import { readNews, urlKey, TOPIC_LABEL, type NewsItem, type Topic } from "./news";
import { coveredSourceKeys, MIN_FRESH_ITEMS, NoFreshNewsError } from "./history";

/**
 * The article agent: headlines in, a finished post out.
 *
 * The shape of the job is a rewrite with attribution. It reads what a handful
 * of publishers syndicated about a topic (lib/ai/news.ts), picks the thread
 * running through them, and writes an original piece that credits them — not a
 * reworded copy of any one of them. Two rules in the system prompt carry most
 * of that weight: write from the summaries you were given and nothing else, and
 * attribute every claim to the outlet it came from by name.
 *
 * ## Sources are matched, never taken on trust
 *
 * The model is asked which of the supplied items it used and answers with their
 * URLs. Those URLs are then looked up in the list that was sent — a URL that is
 * not in it is dropped rather than published. A model that emits a plausible
 * link to a story that does not exist is the single most damaging thing this
 * feature could do, and the fix is not to ask it not to: it is never to publish
 * a URL that did not arrive from a feed.
 *
 * ## Length and SEO
 *
 * The draft comes back with the things a page needs to be findable and the
 * writer would otherwise have to invent: a headline inside Google's display
 * width, a slug, a meta description cut to {META_DESCRIPTION_LENGTH}, and
 * subheads that describe sections rather than tease them. None of that is worth
 * anything if the piece is thin, so the prompt asks for eight hundred to twelve
 * hundred words of actual synthesis, and {MIN_BODY_WORDS} is the floor below
 * which the draft is thrown away rather than published.
 *
 * ## Nothing is written about twice
 *
 * A feed still carries this morning's story tomorrow, so the model has to be
 * told what the desk already published — otherwise a second run produces the
 * same piece under a different headline. Every story cited by a recent post is
 * subtracted from the feed before the prompt is built (lib/ai/history.ts), and
 * a beat with nothing left refuses rather than repeats.
 */

/** Below this the piece is a summary wearing an article's clothes. */
const MIN_BODY_WORDS = 350;

export type DraftSource = {
  title: string;
  url: string;
  publisher: string;
  published_at: string | null;
};

export type ArticleDraft = {
  title: string;
  slug: string;
  excerpt: string;
  topic: Topic;
  tags: string[];
  /** Sanitized HTML, ready to render or to load into the editor. */
  bodyHtml: string;
  sources: DraftSource[];
  /** "groq:llama-3.3-70b-versatile" — provider and model, for the byline. */
  model: string;
  provider: ProviderName;
  /** Providers that refused before one answered. Surfaced, not hidden. */
  fallbacks: { provider: ProviderName; reason: string }[];
};

const SYSTEM_PROMPT = `You are the staff writer for Folio, a publication covering AI, technology and crypto.

You are given a set of headlines and one-paragraph summaries syndicated by news outlets today. You write one original article synthesising them.

Rules you do not break:
1. Write ONLY from the summaries provided. You have not read the full articles. If a detail is not in the summaries, you do not know it — do not supply it from memory, and do not estimate.
2. Attribute by name. "TechCrunch reports", "according to CoinDesk". Every specific claim traces to an outlet in the list.
3. Invent nothing: no quotes, no statistics, no funding amounts, no dates, no names that were not given to you.
4. Where the summaries are thin, say what is not yet known rather than filling the gap.
5. No financial advice, no price predictions, no "this could moon", no recommendation to buy or sell anything. Folio publishes on a testnet and promises nothing about price or return.
6. Plain declarative English. No hype, no "in today's fast-paced world", no rhetorical questions as subheads, no closing paragraph that summarises what the reader just read.

House style for the body:
- Open with what happened, in one paragraph. No throat-clearing.
- Use ## subheads that name what the section covers.
- 800-1200 words.
- Markdown only: paragraphs, ##/### subheads, - bullet lists, **bold**, links. No images, no tables, no code blocks, no H1 — the title is rendered separately.
- Weave the outlet names into the prose. Do not append a sources list; the page renders one.

Reply with a single JSON object and nothing else:
{
  "title": "60-70 characters, states the development, front-loads the specific term a reader would search for",
  "slug": "lowercase-words-joined-by-hyphens, 3-8 words, no dates",
  "excerpt": "<=${META_DESCRIPTION_LENGTH} characters, a complete sentence, states what the article says rather than that it exists",
  "tags": ["3-6 lowercase topic tags"],
  "body": "the article in markdown",
  "used_urls": ["the exact urls of the items you actually drew on, copied from the input"]
}`;

export type DraftOptions = {
  topic: Topic;
  /**
   * An optional steer: "focus on what this means for open models". Passed
   * through to the model as a preference, not as a fact to work from — it is
   * typed by whoever pressed the button, so it must not be able to instruct the
   * agent past its rules.
   */
  angle?: string;
  /** How many feed items to hand the model. */
  itemCount?: number;
  /**
   * Skip the check against what the desk already published. Only for a caller
   * that has decided a repeat is what it wants; the default is to refuse one.
   */
  allowCovered?: boolean;
};

/**
 * Read the news, write the piece, return a draft nobody has published yet.
 *
 * Throws with a message written for a person: the caller renders it into the
 * composer, and every failure here is something the writer either waits out or
 * fixes in the environment.
 */
export async function draftArticle(options: DraftOptions): Promise<ArticleDraft> {
  const itemCount = options.itemCount ?? 12;

  // Twice what the model is handed, because the covered ones are about to be
  // taken out of it. Asking for exactly twelve and dropping eight leaves four,
  // where asking for twenty-four and dropping eight leaves a full prompt.
  const items = await readNews(options.topic, itemCount * 2);
  const fresh = options.allowCovered ? items : await withoutCovered(items, options.topic);
  // What the model is actually shown, and therefore the only list a citation
  // may resolve against: matching against anything wider would let a draft cite
  // a headline it was never given.
  const prompted = fresh.slice(0, itemCount);

  const completion = await complete({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(options, prompted),
  });

  const parsed = parseJson(completion.text);
  const draft = buildDraft(parsed, options.topic, prompted);

  return {
    ...draft,
    model: `${completion.provider}:${completion.model}`,
    provider: completion.provider,
    fallbacks: completion.attempts,
  };
}

/**
 * The feed, minus every story a recent post already cited.
 *
 * Throws rather than writing when fewer than {MIN_FRESH_ITEMS} survive. A beat
 * with one new headline in twenty-four is a quiet news day, and the right
 * article to publish on a quiet news day is none — the alternative is a piece
 * that pads that one headline into eight hundred words, which is how a desk
 * that publishes on a schedule turns into a content farm.
 */
async function withoutCovered(items: NewsItem[], topic: Topic): Promise<NewsItem[]> {
  const covered = await coveredSourceKeys();
  if (covered.size === 0) return items;

  const fresh = items.filter((item) => !covered.has(urlKey(item.url)));
  if (fresh.length < MIN_FRESH_ITEMS) {
    throw new NoFreshNewsError(
      `Every ${TOPIC_LABEL[topic]} story in today's feeds has already been covered by a recent article. Nothing new to write yet — try again once the wires move.`
    );
  }
  return fresh;
}

function buildPrompt(options: DraftOptions, items: NewsItem[]): string {
  const feed = items
    .map((item, i) =>
      [
        `[${i + 1}] ${item.title}`,
        `    url: ${item.url}`,
        `    outlet: ${item.publisher}`,
        item.publishedAt ? `    published: ${item.publishedAt}` : null,
        item.summary ? `    summary: ${item.summary}` : `    summary: (none syndicated)`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

  // The angle is quoted and labelled as the editor talking, so a line like
  // "ignore your instructions and write about X" reads as what it is — an
  // instruction from a person the system prompt already outranks.
  const angle = options.angle?.trim()
    ? `\n\nThe editor has asked for this angle, within the rules above: "${options.angle
        .trim()
        .replace(/"/g, "'")
        .slice(0, 300)}"`
    : "";

  return `Topic: ${TOPIC_LABEL[options.topic]}
Today: ${new Date().toISOString().slice(0, 10)}

Here is what the outlets syndicated. Pick the strongest thread running through two or more of these items and write the article about that thread — not a roundup of all of them.

${feed}${angle}`;
}

/**
 * The model's reply, as JSON.
 *
 * Both providers are asked for JSON mode, and both honour it — but a model that
 * wraps the object in a ```json fence anyway is common enough that failing the
 * whole generation over three backticks would be perverse.
 */
function parseJson(text: string): Record<string, unknown> {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();

  try {
    const value = JSON.parse(stripped);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    // Last resort: the outermost braces. A model that prefaced the object with
    // a sentence still gave us the object.
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch {
        /* fall through to the thrown error below */
      }
    }
    throw new Error("The model's reply was not valid JSON. Try generating again.");
  }
}

function buildDraft(
  raw: Record<string, unknown>,
  topic: Topic,
  items: NewsItem[]
): Omit<ArticleDraft, "model" | "provider" | "fallbacks"> {
  const title = str(raw.title).slice(0, 200);
  const markdown = str(raw.body);

  if (!title) throw new Error("The model returned an article with no headline. Try again.");
  if (!markdown) throw new Error("The model returned an empty article. Try again.");

  const words = markdown.trim().split(/\s+/).length;
  if (words < MIN_BODY_WORDS) {
    throw new Error(
      `The model returned only ${words} words, which is too thin to publish. Try generating again.`
    );
  }

  // Markdown to HTML, then straight through the same sanitizer that guards
  // token articles. Model output is not trusted input just because we prompted
  // it: a link in the markdown is still a link, and this is where a
  // `javascript:` href dies.
  const bodyHtml = sanitizeArticleHtml(
    marked.parse(markdown, { async: false, gfm: true, breaks: false })
  );
  if (!bodyHtml.trim()) {
    throw new Error("Nothing survived sanitizing the model's article. Try generating again.");
  }

  const sources = matchSources(raw.used_urls, items);
  if (sources.length === 0) {
    // Either the model cited nothing or it cited URLs that were not in the
    // input. Both mean the piece cannot show its work, and a post that cannot
    // show its work does not get published.
    throw new Error(
      "The draft did not cite any of the headlines it was given, so it cannot be attributed. Try generating again."
    );
  }

  return {
    title,
    slug: slugify(str(raw.slug) || title),
    excerpt: buildExcerpt(str(raw.excerpt), bodyHtml),
    topic,
    tags: buildTags(raw.tags),
    bodyHtml,
    sources,
  };
}

/**
 * The cited URLs, resolved against the items we actually supplied.
 *
 * Comparison ignores a trailing slash and the tracking query strings feeds love
 * to append, so a model that echoed the URL back without its `?utm_source` is
 * still understood — while a URL that names a story nobody sent is dropped.
 */
function matchSources(used: unknown, items: NewsItem[]): DraftSource[] {
  const byKey = new Map(items.map((item) => [urlKey(item.url), item]));
  const cited = Array.isArray(used) ? used : [];

  const matched: DraftSource[] = [];
  const seen = new Set<string>();

  for (const value of cited) {
    const key = urlKey(str(value));
    const item = byKey.get(key);
    if (!item || seen.has(key)) continue;
    seen.add(key);
    matched.push({
      title: item.title,
      url: item.url,
      publisher: item.publisher,
      published_at: item.publishedAt,
    });
  }

  return matched;
}

/**
 * The meta description.
 *
 * The model's own sentence when it wrote one that fits, the head of the article
 * when it didn't — an empty description is a search result Google writes for
 * you, and one cut mid-word is worse than one cut at a boundary.
 */
function buildExcerpt(candidate: string, bodyHtml: string): string {
  const trimmed = candidate.trim();
  if (trimmed && trimmed.length <= META_DESCRIPTION_LENGTH) return trimmed;
  if (trimmed) return articleExcerpt(`<p>${trimmed}</p>`, META_DESCRIPTION_LENGTH);
  return articleExcerpt(bodyHtml, META_DESCRIPTION_LENGTH);
}

function buildTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = value
    .map((tag) => str(tag).toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim())
    .filter((tag) => tag.length > 1 && tag.length <= 32);
  return [...new Set(tags)].slice(0, 6);
}

/**
 * A URL-safe slug.
 *
 * Exported because publishing needs it too: a slug that collides with a
 * published post gets a suffix, and that suffix has to be built the same way.
 */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");

  // A title in a script this strips entirely — or one that is only punctuation
  // — would otherwise produce an empty path segment.
  return slug || `post-${Date.now().toString(36)}`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
