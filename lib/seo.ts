import type { Metadata } from "next";
import { siteUrl } from "./siteUrl";
import { articleExcerpt } from "./sanitize";
import { shortAddress, type Token } from "./types";

/**
 * One place for the strings and shapes that end up in <head>.
 *
 * Two things about Next's metadata resolution drive the design here, and both
 * are easy to get wrong:
 *
 *  1. A child route's `openGraph` object REPLACES the parent's — it is not
 *     merged key by key. A page that sets `openGraph.title` and nothing else
 *     silently loses the site name, the locale and the image inherited from
 *     the root layout. So every route that declares openGraph declares all of
 *     it, which is what `socialMetadata()` exists to make cheap.
 *  2. For the same reason, the `app/opengraph-image` file convention is only
 *     applied at a segment whose own metadata does not mention
 *     `openGraph.images`. Since token pages do mention it (they prefer the
 *     token's avatar), the fallback image cannot come from that convention —
 *     it is a real, referenceable URL instead: /og.png.
 */

export const SITE_NAME = "Folio";
export const SITE_TAGLINE = "Every token, told as a story";

/**
 * The site-level description. It says what the thing is and that it settles in
 * testnet ETH; it promises nothing about price or return, which is the same
 * line the terms and the AI writing assistant hold.
 */
export const SITE_DESCRIPTION =
  "A testnet token launchpad where every listing is an article. Write the piece, publish it, and the token it describes is minted onto a bonding curve that quotes both sides of the trade from the page itself.";

/** Built at /og.png by app/og.png/route.tsx. Prerendered, so serving it is free. */
export const DEFAULT_OG_IMAGE = "/og.png";
export const DEFAULT_OG_IMAGE_SIZE = { width: 1200, height: 630 };

/**
 * Google truncates a description around 155–160 characters on desktop and
 * shorter on mobile. Cutting at 155 means the snippet we wrote is the snippet
 * that shows, rather than one Google re-cuts from the body.
 */
export const META_DESCRIPTION_LENGTH = 155;

/** `<title>` for a route: the page's own headline, then the masthead. */
export function pageTitle(headline: string): string {
  return `${headline} — ${SITE_NAME}`;
}

/** An absolute URL, for canonicals and JSON-LD (which has no metadataBase). */
export function absoluteUrl(path: string): string {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function tokenPath(token: Pick<Token, "contract_address">): string {
  return `/token/${token.contract_address}`;
}

/**
 * The social headline for a listing: name and ticker, no "— Folio" suffix.
 * og:title sits beside og:site_name in every card that renders it, so
 * repeating the site name there just spends characters twice.
 */
export function tokenHeadline(token: Pick<Token, "name" | "symbol">): string {
  const name = token.name?.trim() || "Untitled token";
  const symbol = token.symbol?.trim();
  return symbol ? `${name} ($${symbol})` : name;
}

/**
 * The meta description for a listing, taken from the article itself rather
 * than a hand-written field — there is no separate description on a Folio
 * listing, because the article is the description.
 *
 * Rows written by the launch indexer carry a placeholder body, and a row could
 * in principle carry an empty one, so there is a factual fallback that states
 * what the page is without inventing anything about it.
 */
export function tokenDescription(
  token: Pick<Token, "article_body" | "name" | "symbol">
): string {
  const excerpt = articleExcerpt(token.article_body, META_DESCRIPTION_LENGTH);
  if (excerpt) return excerpt;
  return `${tokenHeadline(token)} — a token published on Folio, where every listing is an article and every price is quoted by the contract.`;
}

/**
 * Only http(s) URLs are allowed through to og:image.
 *
 * avatar_url arrives from a table anyone holding the public anon key may
 * insert into, and the insert policy does not constrain it. A relative or
 * `javascript:` value would at best resolve to nonsense against metadataBase
 * and at worst throw during metadata resolution, taking the page with it.
 */
function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

type SocialImage = { url: string; width?: number; height?: number; alt: string };

/** The token's own image when it has a usable one, the Folio card otherwise. */
export function socialImage(
  candidate: string | null | undefined,
  alt: string
): SocialImage {
  if (isHttpUrl(candidate)) return { url: candidate, alt };
  return {
    url: DEFAULT_OG_IMAGE,
    ...DEFAULT_OG_IMAGE_SIZE,
    alt: `${SITE_NAME} — ${SITE_TAGLINE}`,
  };
}

type SocialOptions = {
  /** og:title and twitter:title. Without the "— Folio" suffix; see above. */
  title: string;
  description: string;
  /** Route path, e.g. "/create". Resolved against metadataBase by Next. */
  path: string;
  /** Candidate image URL; falls back to the default card when unusable. */
  image?: string | null;
  imageAlt?: string;
  /** Present for a page that is a piece of writing rather than a screen. */
  article?: { publishedTime?: string; modifiedTime?: string; authors?: string[] };
};

/**
 * A complete Open Graph + Twitter block. Spread it into a route's metadata:
 *
 *   export const metadata: Metadata = {
 *     title: pageTitle("About"),
 *     description: DESCRIPTION,
 *     alternates: { canonical: "/about" },
 *     ...socialMetadata({ title: "About", description: DESCRIPTION, path: "/about" }),
 *   };
 *
 * twitter:card is always summary_large_image: X and Telegram both render the
 * wide card from it, and the default card crops to a small square that loses
 * the headline.
 */
export function socialMetadata(
  options: SocialOptions
): Pick<Metadata, "openGraph" | "twitter"> {
  const images = [socialImage(options.image, options.imageAlt ?? options.title)];

  const shared = {
    title: options.title,
    description: options.description,
    url: options.path,
    siteName: SITE_NAME,
    locale: "en_US",
    images,
  };

  return {
    openGraph: options.article
      ? {
          ...shared,
          type: "article",
          publishedTime: options.article.publishedTime,
          modifiedTime: options.article.modifiedTime ?? options.article.publishedTime,
          authors: options.article.authors,
        }
      : { ...shared, type: "website" },
    twitter: {
      card: "summary_large_image",
      title: options.title,
      description: options.description,
      images,
    },
  };
}

/* ==========================================================================
   JSON-LD
   ========================================================================== */

/**
 * Serialize a JSON-LD object for a <script> body.
 *
 * `JSON.stringify` alone is not safe here: article titles are user input, and
 * a title containing "</script>" would close the tag and put the rest of the
 * document in HTML context. Escaping the three characters that can start a tag
 * or an entity — plus the two line separators that are legal in JSON but not
 * in a JavaScript string literal — makes the payload inert.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const PUBLISHER = {
  "@type": "Organization",
  name: SITE_NAME,
  url: absoluteUrl("/"),
  logo: {
    "@type": "ImageObject",
    url: absoluteUrl(DEFAULT_OG_IMAGE),
    ...DEFAULT_OG_IMAGE_SIZE,
  },
};

/**
 * schema.org/Article for a listing.
 *
 * This is the claim that a Folio token page is a piece of writing with a date
 * and a byline, not a product listing — which is the whole difference between
 * this launchpad and a chart with a buy button, and the reason these pages are
 * worth indexing at all.
 *
 * Everything in it is visible on the page it describes: the headline is the
 * <h1>, the byline is the byline, the date is the date. Structured data that
 * asserts more than the page shows is what gets a site a manual action.
 */
export function tokenArticleJsonLd(
  token: Token,
  options: { authorUrl?: string | null } = {}
): Record<string, unknown> {
  const url = absoluteUrl(tokenPath(token));
  const image = socialImage(token.avatar_url, tokenHeadline(token));
  const published = toIsoDate(token.created_at);

  return {
    "@context": "https://schema.org",
    "@type": "Article",
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    // Google ignores a headline past ~110 characters; article_title may run to
    // 200, so send the part that counts rather than a field it will drop.
    headline: (token.article_title?.trim() || tokenHeadline(token)).slice(0, 110),
    description: tokenDescription(token),
    image: [image.url.startsWith("/") ? absoluteUrl(image.url) : image.url],
    ...(published ? { datePublished: published, dateModified: published } : {}),
    author: {
      "@type": "Person",
      // The short form is what the byline renders; the full address is the
      // identifier behind it. Note this is a claim the site records, not a
      // signature it has verified — see the note on /about.
      name: shortAddress(token.creator_wallet),
      identifier: token.creator_wallet,
      ...(options.authorUrl ? { url: options.authorUrl } : {}),
    },
    publisher: PUBLISHER,
    isAccessibleForFree: true,
  };
}

/** schema.org/WebSite for the front page. */
export function siteJsonLd(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    alternateName: `${SITE_NAME} — ${SITE_TAGLINE}`,
    url: absoluteUrl("/"),
    description: SITE_DESCRIPTION,
    publisher: PUBLISHER,
  };
}

/** An ISO 8601 timestamp, or null for a row whose date will not parse. */
function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
