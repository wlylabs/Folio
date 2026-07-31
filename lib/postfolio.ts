/**
 * Postfolio — the reading side of Folio.
 *
 * Folio is two views of one publication. The launchpad at `/` is the one that
 * sells: every card there carries a ticker, a supply and a curve, because every
 * article there is a token. Postfolio at `/postfolio` is the one that reads —
 * the desk's own articles, which have no token behind them and no reason to be
 * laid out as if they did. The nav switches between them.
 *
 * Its own module, with no imports, for the same reason lib/topics.ts is: the
 * mode switch renders in the browser and lib/seo.ts builds URLs on the server,
 * and putting these four strings in lib/posts.ts would pull the Supabase client
 * into the client bundle to label a link.
 */

export const LAUNCHPAD_NAME = "Launchpad";
export const LAUNCHPAD_PATH = "/";

export const POSTFOLIO_NAME = "Postfolio";
export const POSTFOLIO_PATH = "/postfolio";
export const POSTFOLIO_TAGLINE = "The article desk, read end to end";

/**
 * What Postfolio is, in one sentence, for the masthead and the meta
 * description. It says who writes the articles, because that is the fact a
 * reader of a machine-written publication is owed before the first headline.
 */
export const POSTFOLIO_DESCRIPTION =
  "Postfolio is Folio's reading side: articles on AI, technology and crypto, written by the desk agent from headlines the outlets syndicated and published by a person who read the draft first.";

/** The URL of a published article. */
export function postfolioPath(slug: string): string {
  return `${POSTFOLIO_PATH}/${slug}`;
}

/** Which of the two views a pathname belongs to. */
export function modeForPath(pathname: string): "launchpad" | "postfolio" {
  return pathname === POSTFOLIO_PATH || pathname.startsWith(`${POSTFOLIO_PATH}/`)
    ? "postfolio"
    : "launchpad";
}
