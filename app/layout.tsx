import "./globals.css";
import Providers from "./providers";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import CookieBanner from "@/components/CookieBanner";
import { siteUrl } from "@/lib/siteUrl";

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
  // No `template` here on purpose: the legal routes set their own complete
  // titles, and a template would suffix "— Folio" onto strings that already
  // end in it.
  title: "Folio — Every token, told as a story",
  description: "A testnet token launchpad where every token is an article.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The trade dock sits against the bottom edge, so the page needs to reach
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
    >
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
           * Outside .app-frame: the banner is fixed to the viewport, not part
           * of the page's column.
           *
           * When analytics is added, mount it here and gate it on
           * hasAnalyticsConsent() from lib/consent.ts — re-checking on the
           * CONSENT_EVENT, so a reader who accepts gets it without a reload
           * and one who declines never loads the script at all.
           */}
          <CookieBanner />
        </Providers>
      </body>
    </html>
  );
}
