import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from "@/lib/seo";
import { THEME_CANVAS } from "@/lib/theme";

/**
 * What makes Folio installable.
 *
 * Served at /manifest.webmanifest by Next's file convention, which also emits
 * the <link rel="manifest"> for it — nothing in app/layout.tsx has to name it.
 *
 * The case for installing a launchpad is not novelty. It is the address bar:
 * a reader who trades from a phone spends the whole session watching a page
 * whose top inch is browser chrome, and a wallet handoff that leaves the tab
 * and comes back is the most common way a session is lost. An installed copy
 * keeps its own window, its own storage, and its own place in the task
 * switcher, which is where a WalletConnect approval returns to.
 *
 * Note what is deliberately absent: no `display: "fullscreen"`, which would
 * take the status bar with it and leave a reader unable to see the time or
 * their battery while they sign a transaction, and no `orientation`, because a
 * chart is better in landscape and an article is better in portrait and the
 * reader knows which they are doing.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // `id` is what the browser matches an installed copy against. Pinning it to
    // "/" means a later change to start_url updates the app already on the home
    // screen rather than offering to install a second one beside it.
    id: "/",
    name: `${SITE_NAME} — ${SITE_TAGLINE}`,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Ordered by preference: a browser that has never heard of `minimal-ui`
    // falls through to `display` above, and one that cannot install at all
    // shows an ordinary tab, which is the page this has always been.
    display_override: ["standalone", "minimal-ui"],
    lang: "en",
    dir: "ltr",
    categories: ["finance", "news"],
    // The paper the page opens on: the splash screen behind the icon while the
    // first route loads, and the app's own title bar. Both come from
    // lib/theme.ts, so they cannot drift from `--paper` in the stylesheet.
    background_color: THEME_CANVAS.light,
    theme_color: THEME_CANVAS.light,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Drawn small inside its paper so a launcher can cut any shape it likes
      // out of it — see app/icon-maskable.png.
      { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    /*
     * The two things a reader opens the app to do, on the long-press menu.
     *
     * Both are routes that already exist and both are one tap from the front
     * page anyway; the point is that they are one tap from the *home screen*,
     * which is where an installed app is competing with a wallet's own.
     */
    shortcuts: [
      {
        name: "Launch a token",
        short_name: "Launch",
        description: "Write a listing and mint the token it describes.",
        url: "/create",
      },
      {
        name: "Your desk",
        short_name: "Desk",
        description: "The launches published from your wallet.",
        url: "/profile",
      },
    ],
  };
}
