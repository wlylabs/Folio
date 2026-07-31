import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/siteUrl";

/**
 * Everything public is crawlable — the front page, every listing, the launch
 * form and the legal pages. That is the point: a Folio listing is an article,
 * and an article that crawlers cannot reach is one nobody finds.
 *
 * /profile is not disallowed here on purpose. It is a wallet's own desk and
 * should not be indexed, but it carries links out to listings that should be,
 * so it is marked `noindex, follow` in app/profile/layout.tsx instead — a
 * robots.txt block would stop a crawler reading those links at all.
 *
 * /desk is different and is blocked outright: it is a password box, it links
 * nowhere a crawler needs, and the articles it produces are already public in
 * Postfolio. This is not what keeps it private — lib/desk.ts is — it just keeps
 * it out of a search result.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Nothing to crawl behind the indexer endpoint, and it makes RPC calls.
      disallow: ["/api/", "/desk"],
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
    host: siteUrl(),
  };
}
