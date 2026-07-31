/**
 * What the article agent reads before it writes: public RSS and Atom feeds,
 * three niches, headlines and summaries only.
 *
 * ## Headlines and summaries only, on purpose
 *
 * Nothing here follows a feed item's link to fetch the article behind it. A
 * feed's own `<description>` is what the publisher chose to syndicate — that is
 * what syndication is for — and it is a paragraph, not a piece. Handing a model
 * a paragraph and asking for eight hundred words forces it to do the thing that
 * makes this publishable: write something new about a development, rather than
 * reword somebody's copy and take the byline. Scraping the full text and
 * "rewriting" it would produce a better-informed article and a worse-defended
 * one, and the resulting page would be a duplicate in every sense a search
 * engine cares about.
 *
 * Every item that reaches the model comes back out attached to the draft as a
 * source, and lib/ai/writer.ts rejects a draft that cites none. The published
 * post links them at its foot.
 *
 * ## Why the parser is thirty lines and not a dependency
 *
 * RSS 2.0 and Atom disagree about almost everything except that an item has a
 * title, a link and a date. Those three fields are all this reads, and they are
 * reachable with a tag scan. A full feed parser would handle namespaces,
 * enclosures and podcast extensions that nothing here looks at.
 */

import { TOPIC_LABEL, type Topic } from "@/lib/topics";

const FETCH_TIMEOUT_MS = 10_000;

/** Feeds are polled per request; a few minutes of staleness is free accuracy. */
const FEED_CACHE_MS = 5 * 60_000;

// The beat list itself lives in lib/topics.ts, which the browser can import
// without dragging this module's feed reader along with it.
export { TOPICS, TOPIC_LABEL, isTopic, type Topic } from "@/lib/topics";

/**
 * The default feeds per topic. Override any of them with NEWS_FEEDS_AI,
 * NEWS_FEEDS_TECHNOLOGY or NEWS_FEEDS_CRYPTO — a comma-separated list of feed
 * URLs, which replaces the defaults for that topic rather than adding to them.
 *
 * These are the publishers' own syndication endpoints, which is the interface
 * they offer for exactly this. If one of them starts refusing the request or
 * moves, the agent degrades to the feeds that still answer rather than failing;
 * `readNews` only gives up when nothing answered at all.
 */
const DEFAULT_FEEDS: Record<Topic, string[]> = {
  ai: [
    "https://venturebeat.com/category/ai/feed/",
    "https://www.technologyreview.com/topic/artificial-intelligence/feed",
    "https://feeds.arstechnica.com/arstechnica/technology-lab",
  ],
  technology: [
    "https://techcrunch.com/feed/",
    "https://www.theverge.com/rss/index.xml",
    "https://hnrss.org/frontpage?points=150",
  ],
  crypto: [
    "https://cointelegraph.com/rss",
    "https://decrypt.co/feed",
    "https://www.coindesk.com/arc/outboundfeeds/rss/",
  ],
};

export type NewsItem = {
  title: string;
  url: string;
  /** The feed's own summary, tags stripped and clamped. May be empty. */
  summary: string;
  /** Feed title, or the link's hostname when the feed doesn't name itself. */
  publisher: string;
  /** ISO 8601, or null for an item with no parseable date. */
  publishedAt: string | null;
};

/**
 * Thrown when not one of a topic's feeds answered.
 *
 * Its own class so the route handler can call it what it is — an upstream
 * failure, not a bug in the request — and answer 502 rather than 500.
 */
export class NoFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoFeedError";
  }
}

function feedsFor(topic: Topic): string[] {
  const override = process.env[`NEWS_FEEDS_${topic.toUpperCase()}`];
  if (!override) return DEFAULT_FEEDS[topic];

  const urls = override
    .split(",")
    .map((url) => url.trim())
    .filter((url) => /^https?:\/\//i.test(url));
  return urls.length > 0 ? urls : DEFAULT_FEEDS[topic];
}

const cache = new Map<string, { at: number; items: NewsItem[] }>();

/**
 * The most recent items across a topic's feeds, newest first.
 *
 * Feeds are read in parallel and a failing one is skipped: three publishers
 * means the agent still has something to write about when one of them is down
 * or has started refusing datacentre IPs. Throws only when every feed failed,
 * because a draft written from no sources is the one thing this must not
 * produce.
 */
export async function readNews(topic: Topic, limit = 12): Promise<NewsItem[]> {
  const urls = feedsFor(topic);
  const results = await Promise.allSettled(urls.map((url) => readFeed(url)));

  const items = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );

  if (items.length === 0) {
    // Every publisher is named with its own failure. Feeds fail one at a time
    // and for different reasons — one moved, one started refusing datacentre
    // IPs, one is briefly down — and a single "could not read the news" would
    // send whoever is debugging it to check all three.
    const reasons = results
      .map((result, i) =>
        result.status === "rejected"
          ? `${hostname(urls[i])}: ${
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            }`
          : null
      )
      .filter(Boolean)
      .join("; ");
    throw new NoFeedError(
      `No ${TOPIC_LABEL[topic]} feed could be read${reasons ? ` (${reasons})` : ""}.`
    );
  }

  // Dedupe. An aggregator carries the same story as the outlet that broke it
  // often enough that a naive merge hands the model one story twice and it
  // writes as though two outlets confirmed it. The two copies rarely carry the
  // same tracking parameters, which is why the comparison is on {urlKey} rather
  // than on the URL as it arrived.
  //
  // Of two copies the earlier one wins, because publication order is what tells
  // an original from a repost: Hacker News links to the TechCrunch article
  // hours after TechCrunch published it, and the copy that survives decides
  // which outlet the finished piece credits. An undated item never displaces a
  // dated one — a feed that omits pubDate would otherwise beat every original.
  const best = new Map<string, NewsItem>();
  for (const item of items) {
    const key = urlKey(item.url);
    const held = best.get(key);
    if (!held || isEarlier(item, held)) best.set(key, item);
  }

  const unique = [...best.values()];
  unique.sort((a, b) => dateValue(b.publishedAt) - dateValue(a.publishedAt));
  return unique.slice(0, limit);
}

async function readFeed(url: string): Promise<NewsItem[]> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < FEED_CACHE_MS) return cached.items;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let xml: string;
  try {
    const response = await fetch(url, {
      // Some publishers serve a 403 to a request with no User-Agent. This one
      // says what the request is and where to complain, which is the polite
      // form and the one least likely to be blocked.
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        "user-agent": "FolioArticleAgent/1.0 (+https://github.com/wlylabs/folio)",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    xml = await response.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const items = parseFeed(xml, url);
  cache.set(url, { at: Date.now(), items });
  return items;
}

/* ==========================================================================
   Parsing
   ========================================================================== */

/** RSS `<item>` and Atom `<entry>` are the same object under two names. */
function parseFeed(xml: string, feedUrl: string): NewsItem[] {
  const publisher = firstTag(xml.split(/<(?:item|entry)[\s>]/i)[0] ?? "", "title") || hostname(feedUrl);

  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];

  return blocks
    .map((block): NewsItem | null => {
      const title = clean(firstTag(block, "title"));
      const url = extractLink(block);
      if (!title || !url) return null;

      return {
        title,
        url,
        // Atom prefers `summary`, RSS `description`; content:encoded is the
        // full body some feeds add, and it is deliberately not read — see the
        // note at the top of this file.
        summary: clean(firstTag(block, "description") || firstTag(block, "summary")).slice(0, 600),
        publisher: clean(publisher),
        publishedAt: parseDate(
          firstTag(block, "pubDate") || firstTag(block, "published") || firstTag(block, "updated")
        ),
      };
    })
    .filter((item): item is NewsItem => item !== null);
}

/**
 * The item's link.
 *
 * RSS puts it in the element body; Atom puts it in an `href` attribute and may
 * offer several, of which only `rel="alternate"` (or no rel at all) is the
 * article — `rel="replies"` and `rel="enclosure"` point elsewhere.
 */
function extractLink(block: string): string {
  const atom = [...block.matchAll(/<link\b([^>]*)\/?>/gi)]
    .map((match) => match[1])
    .find((attrs) => {
      const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
      return !rel || rel.toLowerCase() === "alternate";
    });

  const href = atom ? /\bhref\s*=\s*["']([^"']+)["']/i.exec(atom)?.[1] : undefined;
  const candidate = clean(href || firstTag(block, "link") || firstTag(block, "guid"));

  // A guid is often a URL and often isn't; only take it when it is one.
  return /^https?:\/\//i.test(candidate) ? candidate : "";
}

function firstTag(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return match?.[1] ?? "";
}

/**
 * A feed field as plain text.
 *
 * The order is the whole trick, and getting it wrong leaves markup in the
 * output. A feed carries its HTML one of two ways: wrapped in CDATA, where the
 * tags are literal, or XML-escaped, where `<p>` arrives as `&lt;p&gt;`. So the
 * entities have to be decoded *before* the tags are stripped, or the escaped
 * form decodes into markup after the stripper has already gone past.
 *
 * Then decode a second time, because the escaped form escapes its own entities
 * too: `&amp;gt;` in the source is `&gt;` in the HTML and `>` in the text. A
 * second pass over already-plain text is harmless — there is nothing left in it
 * that looks like an entity.
 */
function clean(value: string): string {
  return decodeEntities(
    decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).replace(/<[^>]*>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** The five XML entities plus the one every publisher uses anyway. */
function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    return named[body.toLowerCase()] ?? entity;
  });
}

/**
 * A URL reduced to the story it points at: no scheme case, no `www.`, no
 * trailing slash, no query string.
 *
 * Feeds append tracking parameters, and the same article syndicated twice
 * arrives with two different ones. Used to dedupe the feed merge here, and
 * again in lib/ai/writer.ts to match a citation back to the item it came from —
 * both are the same question, "is this the same story", and they must answer it
 * the same way or a model that echoed a URL back verbatim would fail to match.
 */
export function urlKey(value: string): string {
  try {
    const url = new URL(value.trim());
    url.search = "";
    url.hash = "";
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function parseDate(value: string): string | null {
  const date = new Date(clean(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Undated items sort last rather than to 1970. */
function dateValue(iso: string | null): number {
  if (!iso) return 0;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? 0 : value;
}

/** True when `candidate` was published before `held`. Undated is never earlier. */
function isEarlier(candidate: NewsItem, held: NewsItem): boolean {
  if (!candidate.publishedAt) return false;
  if (!held.publishedAt) return true;
  return dateValue(candidate.publishedAt) < dateValue(held.publishedAt);
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
