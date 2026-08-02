/**
 * The wallet directory behind WalletConnect's own modal, made to arrive.
 *
 * Two things happen here, and both are about the same screen: the picker that
 * opens when a reader asks for a wallet Folio's own list does not name. It is
 * not in the bundle. It is a list fetched from `api.web3modal.org` when that
 * screen opens, followed by one request per wallet icon.
 *
 * `warmWalletDirectory` opens the connection to that host early.
 * `unblockWalletDirectoryPaging` removes the wait that made the second page of
 * that list take seconds to appear. See each below.
 */

/**
 * A warm connection to the wallet directory, opened before anything asks it a
 * question.
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

/**
 * Wallets per page, matching AppKit's own `entries`. The count only decides how
 * much of the directory one request carries; a drift here is a shorter or
 * longer page, not a broken one.
 */
const PAGE_SIZE = 40;

let unblocked = false;

/**
 * The directory's second page, arriving when its wallets do rather than when
 * its slowest picture does.
 *
 * ---------------------------------------------------------------------------
 * The wait
 * ---------------------------------------------------------------------------
 *
 * AppKit's list is paged. The first forty wallets come down when the screen
 * opens; scrolling to the bottom of them asks for the next forty. Each page is
 * one request for the names and one request per icon, and `fetchWalletsByPage`
 * awaits *twenty icons* before it puts a single wallet into the state the grid
 * renders from. So the reader who scrolls sits in front of a screen of grey
 * placeholders until the twentieth picture lands — which is the report this is
 * answering, and it is worse than it sounds on mobile data, where twenty
 * images is most of a second even after the connection above is warm.
 *
 * Nothing needs that wait. Every tile in that grid already fetches its own icon
 * when it scrolls into view — `w3m-all-wallets-list-item` keeps an
 * IntersectionObserver for exactly that, and shows a shimmer of its own until
 * the picture arrives. The page-level fetch is a second, eagerer copy of work
 * the tiles do for themselves, and holding the names hostage to it means the
 * reader cannot even read a wallet's *name* until every picture is in.
 *
 * Dropped, the grid fills the moment the names land and each icon appears in
 * its own tile a beat later. It is also strictly less network: the two copies
 * of that work were racing each other, and `_fetchWalletImage` has no in-flight
 * de-duplication, so the same icon was routinely fetched twice.
 *
 * ---------------------------------------------------------------------------
 * The cost of doing it this way
 * ---------------------------------------------------------------------------
 *
 * This replaces a method on a controller inside @reown/appkit-controllers,
 * which is a package Folio does not talk to anywhere else and does not control
 * the version of — @walletconnect/ethereum-provider brings it. Both are pinned,
 * and the version is named in package.json so the copy this patches is the copy
 * AppKit uses rather than a second one npm resolved alongside it.
 *
 * It is written to fail quietly and completely. If the controller is not the
 * shape this expects, nothing is replaced and the stock wait comes back — a
 * slow screen, which is where this started, rather than a broken one. The body
 * below is AppKit's own, minus the two lines that await the icons.
 *
 * Loaded by dynamic import so the controllers stay out of Folio's bundle, and
 * called at the boot level that pulls AppKit in anyway (see lib/wagmiConfig.ts)
 * — a reader who never opens that screen never downloads any of it.
 */
export function unblockWalletDirectoryPaging(): void {
  if (unblocked || typeof window === "undefined") return;
  unblocked = true;

  void import("@reown/appkit-controllers")
    .then(({ ApiController, ChainController, CoreHelperUtil, OptionsController }) => {
      if (
        typeof ApiController?.fetchWalletsByPage !== "function" ||
        typeof ApiController.fetchWallets !== "function" ||
        typeof ApiController._filterOutExtensions !== "function" ||
        typeof ChainController?.getRequestedCaipNetworkIds !== "function" ||
        typeof CoreHelperUtil?.uniqueBy !== "function"
      ) {
        return;
      }

      ApiController.fetchWalletsByPage = async ({ page }) => {
        const { includeWalletIds, excludeWalletIds, featuredWalletIds } = OptionsController.state;
        const chains = ChainController.getRequestedCaipNetworkIds().join(",");
        // A wallet already shown above the list is not shown again in it.
        const exclude = [
          ...ApiController.state.recommended.map(({ id }) => id),
          ...(excludeWalletIds ?? []),
          ...(featuredWalletIds ?? []),
        ].filter(Boolean);

        const { data, count } = await ApiController.fetchWallets({
          page,
          entries: PAGE_SIZE,
          include: includeWalletIds,
          exclude,
          chains,
        });

        // Here is where the icons used to be awaited. The tiles have it.
        const { state } = ApiController;
        state.wallets = CoreHelperUtil.uniqueBy(
          [...state.wallets, ...ApiController._filterOutExtensions(data)],
          "id"
        ).filter((wallet) => wallet.chains?.some((chain) => chains.includes(chain)));
        state.count = count > state.count ? count : state.count;
        state.page = page;
      };
    })
    .catch(() => {
      // The controllers could not be loaded. Then there is no list to speed up
      // either, and whatever is wrong will be reported by the modal itself.
    });
}
