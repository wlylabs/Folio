/**
 * The site's public origin, for canonical URLs and the sitemap.
 *
 * Set NEXT_PUBLIC_SITE_URL to the real domain in production. On Vercel,
 * VERCEL_URL is filled in automatically per deployment, which is right for
 * previews and good enough for a first production deploy — but it changes with
 * every deployment, so a canonical URL built from it is not stable. Name the
 * domain explicitly once there is one.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const vercel = process.env.NEXT_PUBLIC_VERCEL_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;

  return "http://localhost:3000";
}
