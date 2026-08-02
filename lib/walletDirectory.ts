/**
 * A warm connection to the wallet directory, opened before anything asks it a
 * question.
 *
 * The wallet picker behind WalletConnect's own modal is not in the bundle. It
 * is a list fetched from `api.web3modal.org` when that screen opens, followed
 * by one request per wallet icon — twenty of them, and AppKit awaits every one
 * before it will render a single tile. Nothing renders until the slowest image
 * lands.
 *
 * The first of those requests also pays for the introduction: a DNS lookup, a
 * TCP handshake and a TLS negotiation with a host this page has never spoken
 * to. On a phone on mobile data that is a meaningful part of the wait, and it
 * is the part that can be moved. `preconnect` does the introduction now and
 * hands the finished connection to whoever asks next, so the fetch that used to
 * start with a handshake starts with a request.
 *
 * Timed with the wallet SDKs rather than with the page: this fires when the
 * wallet layer is allowed to build itself, which is a pointer arriving at a
 * connect button — see lib/walletBoot.ts. A reader who never goes near one
 * opens no connection to anybody, which is the same bargain the SDKs
 * themselves are on, and it matters more here than there: this is a third
 * party being told a reader exists.
 *
 * `crossorigin` is not decoration. AppKit fetches the list and the icons with
 * CORS, and a preconnect made without it opens a *different* connection from
 * the one those requests need — the handshake happens twice and the warming is
 * wasted. The origin also has to be allowed by connect-src; see
 * lib/securityHeaders.js, where leaving it out broke that screen outright.
 */

/** Where Reown's wallet directory lives. Mirrors `W3M_API_URL` in
 *  @reown/appkit-common — a rename there is a stale hint here, not a break. */
const DIRECTORY_ORIGIN = "https://api.web3modal.org";

let opened = false;

/**
 * Open the connection, once.
 *
 * Idempotent and safe to call from an event that fires on every pointer move:
 * the guard is checked before the DOM is touched. Does nothing on the server,
 * where there is no head to put a hint in, and nothing on a browser that has
 * never heard of preconnect — an ignored `<link>` is an ignored `<link>`.
 */
export function warmWalletDirectory(): void {
  if (opened || typeof document === "undefined") return;
  opened = true;

  const hint = document.createElement("link");
  hint.rel = "preconnect";
  hint.href = DIRECTORY_ORIGIN;
  hint.crossOrigin = "anonymous";
  document.head.appendChild(hint);
}
