import "./globals.css";
import Providers from "./providers";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import CookieBanner from "@/components/CookieBanner";
import AppStatus from "@/components/AppStatus";
import { siteUrl } from "@/lib/siteUrl";
import { BOOT_SCRIPT } from "@/lib/boot";
import {
  pageTitle,
  socialMetadata,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
} from "@/lib/seo";

import { Inter, PT_Serif, Playfair_Display } from "next/font/google";
import type { Metadata, Viewport } from "next";

/*
 * The three faces, self-hosted by next/font rather than pulled from Google's
 * CDN at runtime. That removes a third-party connection from the critical
 * path and, more visibly, removes the flash of fallback text: next/font emits
 * a size-adjusted local fallback, so the first paint is already the right
 * shape. Each exposes a CSS variable that globals.css reads.
 */
const display = Playfair_Display({
  subsets: ["latin"],
  weight: ["700", "900"],
  variable: "--font-display-loaded",
  display: "swap",
});

const text = PT_Serif({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-text-loaded",
  display: "swap",
});

const ui = Inter({
  subsets: ["latin"],
  variable: "--font-ui-loaded",
  display: "swap",
});

export const metadata: Metadata = {
  // Canonical and og:url on child routes are written relative ("/terms"), so
  // they need an origin to resolve against.
  metadataBase: new URL(siteUrl()),
  // No `template` here on purpose: the routes below set their own complete
  // titles through pageTitle(), and a template would suffix "— Folio" onto
  // strings that already end in it.
  title: pageTitle(SITE_TAGLINE),
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  // Emits <link rel="manifest">. The manifest itself is app/manifest.ts.
  manifest: "/manifest.webmanifest",
  /*
   * iOS reads none of the manifest. An installed copy there takes its name,
   * its window and its status bar from these three tags alone.
   *
   * `statusBarStyle: "default"` is the one that looks wrong and is right: the
   * two alternatives paint the status bar a fixed colour, and this page has two
   * palettes. Left alone, iOS draws the bar over the page's own background,
   * which is the paper the reader chose — and with `viewportFit: "cover"`
   * below, the masthead already keeps its text clear of it.
   */
  appleWebApp: {
    capable: true,
    title: SITE_NAME,
    statusBarStyle: "default",
  },
  // These are the defaults a route inherits when it declares no openGraph of
  // its own. A route that declares one replaces this wholesale — Next does not
  // merge the two — which is why every page below builds its block with
  // socialMetadata() rather than setting one or two keys.
  ...socialMetadata({
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    path: "/",
  }),
  // Google Search Console's HTML-tag verification method. A property has to be
  // verified before a sitemap can be submitted or a URL inspected, and this is
  // the one way to do it that survives a redeploy without touching DNS. Read
  // server-side, so the token never reaches the client bundle; the tag is
  // omitted entirely while the variable is unset.
  verification: process.env.GOOGLE_SITE_VERIFICATION
    ? { google: process.env.GOOGLE_SITE_VERIFICATION }
    : undefined,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The consent strip sits against the bottom edge, so the page needs to reach
  // under the home indicator for env(safe-area-inset-bottom) to mean anything.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${text.variable} ${ui.variable}`}
      // The boot script below writes `data-theme` and `color-scheme` onto this
      // element before React ever sees it, which is exactly the kind of
      // difference hydration is built to complain about. It is deliberate, and
      // the warning is the only thing suppressed — the attributes are not
      // rendered here, so React has nothing to disagree with afterwards.
      suppressHydrationWarning
    >
      <head>
        {/*
          The palette and everything else that has to be settled before the
          first paint.

          It has to be inline and it has to be here: a reader who asked for the
          dark page and gets a full-brightness flash of paper first has been
          told their setting does not work, whatever happens a frame later.
          React cannot run this early, so a few lines of plain script do — see
          lib/boot.ts, which owns this string and explains each thing it does.
        */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Providers>
          <div className="app-frame">
            <Nav />
            {children}
            <Footer />
          </div>
          {/*
           * Outside .app-frame: everything in here is fixed to the viewport,
           * not part of the page's column.
           *
           * Both of these speak from the bottom edge, and either can be on
           * screen while the other is, so they share one stack rather than
           * being layered on top of each other. Order is deliberate: a strip
           * reporting that the connection is gone sits above the one asking
           * about cookies, because only one of the two is urgent.
           *
           * When analytics is added, mount it here and gate it on
           * hasAnalyticsConsent() from lib/consent.ts — re-checking on the
           * CONSENT_EVENT, so a reader who accepts gets it without a reload
           * and one who declines never loads the script at all.
           */}
          <div className="edge-stack">
            <AppStatus />
            <CookieBanner />
          </div>
        </Providers>
      </body>
    </html>
  );
}
