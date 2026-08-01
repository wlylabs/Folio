/**
 * The site's public origin, for canonical URLs and the sitemap.
 *
 * Set NEXT_PUBLIC_SITE_URL to the real domain in production. Everything below
 * it is a fallback for a deploy that has not named one yet, in the order that
 * costs a search engine the least:
 *
 *  1. VERCEL_PROJECT_PRODUCTION_URL — the project's stable production alias,
 *     e.g. dappfolio.vercel.app. Only trusted on a production deploy (see
 *     below), and only useful there, but that is exactly where a canonical
 *     matters. Without it a production build falls through to VERCEL_URL.
 *  2. VERCEL_URL — the per-deployment host, e.g. folio-k3f9x2-acme.vercel.app.
 *     Correct for the deploy that is serving, but it changes on every push, and
 *     Vercel serves those hosts with `X-Robots-Tag: noindex`. A production page
 *     that names one as its canonical is pointing Google at a URL Google has
 *     been told not to index — which reads as "do not index this page either".
 *  3. localhost, for a dev server.
 *
 * VERCEL_PROJECT_PRODUCTION_URL is set on preview deploys too, and taking it
 * there would be wrong twice over: a preview would claim production's canonical
 * and render production's og:image beside its own changes. So previews keep the
 * old behaviour and stay self-consistent on their own host.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return stripTrailingSlash(explicit);

  const env = process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV;
  const production =
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (env === "production" && production) {
    return `https://${stripTrailingSlash(production)}`;
  }

  const vercel = process.env.NEXT_PUBLIC_VERCEL_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${stripTrailingSlash(vercel)}`;

  return "http://localhost:3000";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}
