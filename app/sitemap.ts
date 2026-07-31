import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/siteUrl";

/**
 * The static routes, for crawlers. Token pages are deliberately absent: they
 * are database-driven and change constantly, and listing them means a Supabase
 * query on every sitemap fetch. Worth adding when the feed is worth indexing;
 * the legal pages are worth indexing now.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = siteUrl();
  const now = new Date();

  return [
    { url: `${base}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${base}/create`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/about`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${base}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
