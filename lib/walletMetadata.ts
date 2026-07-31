import { siteUrl } from "./siteUrl";

/**
 * What Folio tells a wallet about itself when it asks for a session — and,
 * more usefully, where the wallet should send the reader back to afterwards.
 *
 * Connecting a phone wallet is a round trip between two apps: Folio hands over
 * a pairing URI, the browser goes to the background, the reader approves in the
 * wallet, and then somebody has to bring the browser back. Without a `redirect`
 * in this metadata, nobody does — the wallet has nowhere to send them, so it
 * shows an approved connection and stops, and the reader is left switching apps
 * by hand to find out whether it worked. With one, a wallet that supports the
 * hand-back reopens this page the moment it approves, which is the flow every
 * larger marketplace has and the one this metadata exists to buy.
 *
 * It is not a guarantee. Android wallets generally honour the redirect; from
 * iOS 17 an app can no longer reliably push the reader back into the browser,
 * so on iPhone the return may still be a manual swipe. That is why the redirect
 * is only half the work — WalletSessionSync handles the other half by adopting
 * the approved session whenever the tab comes back, however it got back.
 */

/** The favicon, from Next's app/icon.svg file convention. */
const ICON_PATH = "/icon.svg";

/**
 * One line, because that is what a wallet's approval sheet has room for. The
 * site's own description is a paragraph — right for a search result, too long
 * for the strip of text under "Folio wants to connect".
 */
const WALLET_DESCRIPTION =
  "A testnet token launchpad where every listing is an article.";

/**
 * The origin the reader is actually on, not the one the build was configured
 * with.
 *
 * WalletConnect's Verify API compares the origin a proposal arrives from
 * against `metadata.url`, and a mismatch is what makes a wallet raise a
 * "domain not verified" flag over the approval. NEXT_PUBLIC_SITE_URL is a build
 * setting; a preview deployment, a custom domain, or plain localhost all serve
 * the same build from a different origin. Reading it from the page keeps the
 * two the same wherever it runs, and falls back to the configured URL on the
 * server, where the config is also built but never proposes a session.
 */
function origin(): string {
  if (typeof window === "undefined") return siteUrl();
  return window.location.origin;
}

export const walletConnectMetadata = {
  name: "Folio",
  description: WALLET_DESCRIPTION,
  url: origin(),
  icons: [`${origin()}${ICON_PATH}`],

  redirect: {
    // No `native`: Folio is a website, so there is no app scheme to open. A
    // wallet that finds only `universal` opens the URL in the browser, which is
    // exactly what is wanted here.
    //
    // A getter, because this is read when the session proposal is serialized —
    // at the moment the reader presses connect — rather than when this module
    // loads. The difference is the whole page: a reader who connects from a
    // token page comes back to that token, not to the front page, which is
    // where a value fixed at import time would have dropped them. The wallet
    // stores whatever it is sent for the life of the session, so this is a
    // per-session address, not a per-request one; the page a session is opened
    // from is the best available guess at where its transactions will be signed
    // from too.
    get universal(): string {
      if (typeof window === "undefined") return siteUrl();
      return window.location.href;
    },
  },
};
