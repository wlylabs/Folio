import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/siteUrl";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import { tokenPath } from "@/lib/seo";
import { listPosts, postPath } from "@/lib/posts";
import { POSTFOLIO_PATH } from "@/lib/postfolio";

/**
 * Every public URL on the site, including one per published listing.
 *
 * Regenerated hourly rather than per request. Listing the tokens means a
 * Supabase query, and a sitemap is fetched by crawlers on their own schedule —
 * a bot that pulls it every few minutes must not turn into a query every few
 * minutes. An hour is well inside how fast a search engine acts on a new URL
 * anyway, and a new listing is linked from the front page immediately
 * regardless of when it lands here.
 */
export const revalidate = 3600;

/**
 * The protocol's ceiling is 50,000 URLs per sitemap file. This sits well under
 * it; passing that number means splitting into a sitemap index, which is a
 * different shape and worth doing deliberately rather than by accident.
 */
const MAX_TOKEN_URLS = 5_000;

type TokenRow = { contract_address: string; created_at: string };

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const [tokens, posts] = await Promise.all([getPublishedTokens(), listPosts(MAX_TOKEN_URLS)]);

  // The front page carries both feeds, so it is as fresh as whichever published
  // most recently.
  const newest = [tokens[0]?.created_at, posts[0]?.created_at]
    .map(parseDate)
    .filter((date): date is Date => date !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const frontPageModified = newest ?? new Date();
  const buildTime = new Date();

  const statics: MetadataRoute.Sitemap = [
    { url: `${base}/`, lastModified: frontPageModified, changeFrequency: "daily", priority: 1 },
    {
      // Postfolio's front page. It is the article half of the publication, and
      // it changes exactly when the desk publishes.
      url: `${base}${POSTFOLIO_PATH}`,
      lastModified: parseDate(posts[0]?.created_at) ?? buildTime,
      changeFrequency: "daily",
      priority: 0.8,
    },
    // /create is the only form a visitor can use. The article desk is staff and
    // lives at /desk, which is noindex and disallowed — a sitemap entry for a
    // page that answers with a password box is a crawl budget spent on a door.
    { url: `${base}/create`, lastModified: buildTime, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/about`, lastModified: buildTime, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/terms`, lastModified: buildTime, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/privacy`, lastModified: buildTime, changeFrequency: "yearly", priority: 0.3 },
  ];

  const articles: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${base}${postPath(post)}`,
    // A post is never edited: `posts` has no update policy for any key the app
    // holds, so published is modified.
    lastModified: parseDate(post.created_at) ?? buildTime,
    changeFrequency: "yearly",
    priority: 0.7,
  }));

  const listings: MetadataRoute.Sitemap = tokens.map((token) => ({
    url: `${base}${tokenPath(token)}`,
    // created_at is the real lastModified, not an approximation of one: the RLS
    // policy on `tokens` allows insert and select but neither update nor
    // delete, so a published article is never edited after the fact.
    lastModified: parseDate(token.created_at) ?? buildTime,
    // The article does not change; the curve figures beside it do, with every
    // trade on the page.
    changeFrequency: "daily",
    priority: 0.8,
  }));

  return [...statics, ...listings, ...articles];
}

/**
 * The published listings, newest first.
 *
 * Delisted launches need no filtering here — a delisting deletes the row and
 * leaves a tombstone in `delisted_tokens`, so a removed article is already
 * absent from this query.
 *
 * A failure returns nothing rather than throwing. A sitemap that is missing its
 * token URLs for an hour is a small loss; one that returns a 500 tells Search
 * Console the whole file is broken.
 */
async function getPublishedTokens(): Promise<TokenRow[]> {
  if (!isSupabaseConfigured) return [];

  const { data, error } = await supabase
    .from("tokens")
    .select("contract_address, created_at")
    .order("created_at", { ascending: false })
    .limit(MAX_TOKEN_URLS);

  if (error) {
    console.error("Failed to list tokens for the sitemap:", error);
    return [];
  }
  return (data as TokenRow[]) ?? [];
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
