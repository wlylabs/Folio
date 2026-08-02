/**
 * The wallet directory behind WalletConnect's own modal, made to arrive.
 *
 * Three things happen here, and all of them are about the same screen: the
 * picker that opens when a reader asks for a wallet Folio's own list does not
 * name. It is not in the bundle. It is a list fetched from `api.web3modal.org`
 * when that screen opens, followed by one request per wallet icon.
 *
 * `warmWalletDirectory` opens the connection to that host early.
 * `unblockWalletDirectoryPaging` removes the wait that made the second page of
 * that list take seconds to appear.
 * `unstickWalletDirectoryIcons` keeps a tile whose icon request fails from
 * shimmering forever. See each below.
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

/**
 * Icon requests allowed to be in the air at once.
 *
 * Every tile in the grid asks for its own picture the moment it scrolls into
 * view, and a screenful is about twenty tiles that become visible in the same
 * frame. Twenty simultaneous requests to one host is how a reader on a shared
 * address earns a 429; six is roughly what a browser would have allowed itself
 * over HTTP/1.1, and the queue behind it drains in the order tiles appeared,
 * which is the order the reader is reading them in.
 */
const ICON_CONCURRENCY = 6;

/**
 * Waits before a second and a third try. Long enough that a rate limiter has
 * moved on, short enough that a reader still watching the tile sees it fill.
 */
const ICON_RETRY_DELAYS_MS = [400, 1200];

let unstuck = false;

/**
 * Wallet tiles that stop shimmering, whatever the network does.
 *
 * ---------------------------------------------------------------------------
 * The shimmer that never ends
 * ---------------------------------------------------------------------------
 *
 * `w3m-all-wallets-list-item` fetches its own icon when it scrolls into view,
 * and its body is three lines:
 *
 *     this.imageLoading = true;
 *     this.imageSrc = await AssetUtil.fetchWalletImage(this.wallet.image_id);
 *     this.imageLoading = false;
 *
 * There is no `catch`. `AssetUtil.fetchWalletImage` awaits
 * `ApiController._fetchWalletImage`, which awaits `FetchUtil.getBlob`, which
 * throws on any response that is not a 2xx. So one failed icon — a 429, a
 * dropped connection on a train, a 500 — leaves that tile with `imageLoading`
 * true for as long as the modal is open. It never renders the wallet image
 * element at all, only the shimmer, and the reader sees a grid where some
 * wallets arrived and some are still loading forever. That is the report this
 * is answering.
 *
 * The failures were always possible; what made them visible was taking the
 * eager per-page prefetch out above. That prefetch ran under
 * `Promise.allSettled`, which swallows rejections, and it warmed the first
 * twenty icons of every page into the asset cache before any tile rendered —
 * so the tiles found their pictures already there and never walked the path
 * that can throw. Removing it is still right: it held forty wallets' *names*
 * hostage to twenty pictures. But it means the tiles now do the asking, and
 * the tiles ask badly.
 *
 * ---------------------------------------------------------------------------
 * What this does about it
 * ---------------------------------------------------------------------------
 *
 * Wraps `_fetchWalletImage` — the one function every one of those paths goes
 * through — so that it:
 *
 *   - answers from the asset cache without a request when the icon is already
 *     there;
 *   - shares one request between every caller asking for the same icon at the
 *     same time, which the stock code does for network images and forgot to do
 *     for wallet ones;
 *   - lets only `ICON_CONCURRENCY` requests run at once, so a screenful of
 *     tiles becomes a queue rather than a burst;
 *   - tries again, twice, when the failure is the kind that passes;
 *   - and never rejects.
 *
 * That last one is the actual cure. A tile whose icon is genuinely gone now
 * reaches `this.imageLoading = false` with `imageSrc` undefined, and
 * `wui-wallet-image` draws its placeholder under the wallet's name — a tile a
 * reader can read and press. The rest is what keeps that outcome rare.
 *
 * The same caveats as the paging patch above: it replaces a method inside
 * @reown/appkit-controllers, it checks the shape before it touches anything,
 * and if the shape is not what it expects it leaves the stock behaviour alone.
 * The stock behaviour is a grid that sometimes shimmers forever, which is
 * where this started.
 */
export function unstickWalletDirectoryIcons(): void {
  if (unstuck || typeof window === "undefined") return;
  unstuck = true;

  void import("@reown/appkit-controllers")
    .then(({ ApiController, AssetController }) => {
      const fetchIcon = ApiController?._fetchWalletImage;
      if (
        typeof fetchIcon !== "function" ||
        typeof AssetController?.state?.walletImages !== "object"
      ) {
        return;
      }

      /** In-flight requests, by icon, so a shared icon is fetched once. */
      const pending = new Map<string, Promise<void>>();

      ApiController._fetchWalletImage = (imageId: string): Promise<void> => {
        if (AssetController.state.walletImages[imageId]) return Promise.resolve();

        const already = pending.get(imageId);
        if (already) return already;

        const attempt = (async () => {
          for (let tries = 0; tries <= ICON_RETRY_DELAYS_MS.length; tries += 1) {
            if (tries > 0) await pause(ICON_RETRY_DELAYS_MS[tries - 1]);
            await takeIconSlot();
            try {
              await fetchIcon(imageId);
              return;
            } catch (error) {
              // Out of tries, or a failure that trying again cannot fix. Give
              // the caller a resolved promise and an empty cache: the tile
              // draws its placeholder and stops waiting.
              if (!worthRetrying(error)) return;
            } finally {
              freeIconSlot();
            }
          }
        })();

        pending.set(imageId, attempt);
        void attempt.then(() => pending.delete(imageId));

        return attempt;
      };
    })
    .catch(() => {
      // No controllers, no icons to unstick, and nothing this can do about it.
    });
}

/**
 * Whether a failed icon is worth asking for again.
 *
 * `FetchUtil` throws `new Error(..., { cause: response })`, so a request that
 * reached the host and came back unhappy carries its status here. A rate limit,
 * a timeout and anything the server calls its own fault all pass if they are
 * asked again a moment later. A 404 for an icon the directory no longer has
 * does not, and neither does a 403; those tiles want their placeholder now
 * rather than after two more round trips. No status at all means the fetch
 * never got an answer — offline, DNS, a connection cut mid-flight — which is
 * the most retryable case there is.
 */
function worthRetrying(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  const status = (cause as { status?: unknown } | null | undefined)?.status;
  if (typeof status !== "number") return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

let iconsInFlight = 0;
const iconQueue: (() => void)[] = [];

/** Wait for one of the `ICON_CONCURRENCY` slots, taking it on the way through. */
function takeIconSlot(): Promise<void> {
  if (iconsInFlight < ICON_CONCURRENCY) {
    iconsInFlight += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    iconQueue.push(() => {
      iconsInFlight += 1;
      resolve();
    });
  });
}

/** Hand the slot to whoever has been waiting longest, or back to the pool. */
function freeIconSlot(): void {
  iconsInFlight -= 1;
  iconQueue.shift()?.();
}

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
