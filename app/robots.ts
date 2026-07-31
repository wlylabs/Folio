import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/siteUrl";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Nothing to crawl behind the indexer endpoint, and it makes RPC calls.
      disallow: "/api/",
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
