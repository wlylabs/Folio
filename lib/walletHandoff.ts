/**
 * The other way in: open Folio *inside* a wallet app's own browser.
 *
 * Connecting a phone wallet from a phone browser is a round trip between two
 * apps, and every step of it can fail in a way this site cannot fix — the
 * pairing needs WalletConnect's relay, the wallet has to recognise the chain in
 * the proposal, and something has to hand the reader back afterwards. When any
 * of that goes wrong the reader sees the wallet report "not supported", or
 * nothing at all, and comes back to a page still offering "Connect wallet".
 *
 * A wallet's built-in browser has none of those steps. The page runs inside the
 * wallet, so `window.ethereum` is already there, the connection is local, and
 * there is no app switch to survive. Readers work this out on their own —
 * copy the link, open the wallet, paste it — which is a workaround the site
 * should be offering rather than one they have to discover.
 *
 * So this module is the deep links that do that in one press, plus the two
 * questions that decide whether offering them is useful here.
 */

/** A wallet app that can be handed a URL to open in its own browser. */
export type WalletApp = {
  id: string;
  name: string;
  /** The link that opens `url` inside that app. */
  href: (url: URL) => string;
};

/**
 * The wallets Folio knows how to hand a page to.
 *
 * Deliberately short. Each entry is a universal link that is documented and
 * stable; a wallet whose scheme has to be guessed at would produce a chip that
 * either opens nothing or opens the app's home screen, which is worse than not
 * listing it — hence "Copy link" beside them, which works for every wallet
 * there is.
 */
export const WALLET_APPS: readonly WalletApp[] = [
  {
    id: "metamask",
    name: "MetaMask",
    // Scheme-less by design: metamask.app.link puts https:// back itself, and
    // including it produces a doubled scheme the app refuses.
    href: (url) => `https://metamask.app.link/dapp/${url.host}${url.pathname}${url.search}`,
  },
  {
    id: "coinbase",
    name: "Coinbase Wallet",
    href: (url) => `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url.href)}`,
  },
  {
    id: "trust",
    name: "Trust Wallet",
    // coin_id 60 is Ethereum in SLIP-44, which is what the EVM browser keys off.
    href: (url) => `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url.href)}`,
  },
] as const;

/** The current page, or null on the server where there is no current page. */
function currentUrl(): URL | null {
  if (typeof window === "undefined") return null;
  try {
    return new URL(window.location.href);
  } catch {
    return null;
  }
}

/**
 * Where to send each wallet, for the page the reader is on right now.
 *
 * The page, not the site root: someone pressing this from a token article wants
 * to land back on that article with a wallet attached, not on the front page
 * with the article to find again.
 */
export function walletAppLinks(): { id: string; name: string; href: string }[] {
  const url = currentUrl();
  if (!url) return [];
  return WALLET_APPS.map((app) => ({ id: app.id, name: app.name, href: app.href(url) }));
}

/** The link to hand somebody who wants to paste it into a wallet themselves. */
export function currentPageLink(): string {
  return currentUrl()?.href ?? "";
}

/**
 * Is a wallet already injected into this page?
 *
 * True inside a wallet's own browser and true with a browser extension — in
 * both cases the reader is already where this module would send them, and
 * offering the trip would be noise.
 */
export function hasInjectedProvider(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean((window as { ethereum?: unknown }).ethereum);
}

/**
 * Is this a device where the handoff is the reliable path?
 *
 * A coarse pointer is the honest test for "phone or tablet": it asks about the
 * input device rather than parsing a user-agent string that lies. Desktop
 * browsers are excluded because their answer to a missing wallet is an
 * extension, not an app — and because WalletConnect's QR code, which is what
 * the connect modal shows there, does not depend on this page surviving an app
 * switch.
 */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Whether to offer the handoff at all.
 *
 * Yes on a touch device with no wallet injected — the case the whole module
 * exists for. Yes on any device when WalletConnect has no project ID, because
 * then the connect modal's phone-wallet entries cannot pair however they are
 * pressed, and a link into the wallet's browser is the only route left.
 *
 * Client-only: both questions read the window, so callers must ask from an
 * effect rather than during a render the server also performs.
 */
export function shouldOfferHandoff(walletConnectAvailable: boolean): boolean {
  if (typeof window === "undefined") return false;
  if (hasInjectedProvider()) return false;
  return isTouchDevice() || !walletConnectAvailable;
}
