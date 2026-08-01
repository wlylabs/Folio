/*
 * Folio's service worker.
 *
 * What it is for, in one line: the page should open instantly on a second
 * visit, and a reader who loses their connection should get Folio's own
 * apology rather than the browser's dinosaur.
 *
 * What it is emphatically not for is making the site work offline as though
 * nothing had happened. This is a launchpad — every price on it is quoted by a
 * contract, every balance is read from a chain, and a cached figure is not a
 * slightly old figure but a wrong one. So the rules below are shaped by one
 * question asked of every request: *can this be stale without lying?*
 *
 *   /api/*, and anything that is not a GET     never cached, never served from
 *                                              cache. Prices, trade history,
 *                                              the RPC relay. A stale answer
 *                                              here is a false answer.
 *   navigations (an HTML page)                 network first. The cached copy
 *                                              only ever appears when the
 *                                              network has already failed, and
 *                                              the page says so on screen while
 *                                              it is up — see
 *                                              components/AppStatus.tsx.
 *   /_next/static/*                            cache first, forever. The names
 *                                              carry a content hash, so a
 *                                              changed file is a changed URL
 *                                              and the old one is simply never
 *                                              asked for again.
 *   everything else same-origin (icons, the    stale while revalidating: shown
 *   manifest, images)                          from cache, replaced in the
 *                                              background for next time.
 *
 * Cross-origin requests are not touched at all. Supabase, the chain's RPC, a
 * wallet's relay — none of them are ours to cache, and an opaque response is a
 * thing whose status this worker cannot even read.
 *
 * ---------------------------------------------------------------------------
 * VERSION is the only thing to change by hand.
 *
 * A browser installs a new worker when the bytes of this file change, so
 * bumping it is what retires the caches below and re-fetches the offline page.
 * It does not need bumping for an ordinary deploy: the static assets are hashed
 * (a new build is new URLs), and pages are fetched from the network whenever
 * there is one. Bump it when the logic in here changes.
 * ---------------------------------------------------------------------------
 */

const VERSION = "folio-v1";

const SHELL = `${VERSION}-shell`;
const PAGES = `${VERSION}-pages`;
const ASSETS = `${VERSION}-assets`;

/** Folio's own "you are offline" page. Precached, because the moment it is
 *  needed is the moment it cannot be fetched. */
const OFFLINE_URL = "/offline";

/**
 * How many pages the offline copy holds.
 *
 * A launchpad has an unbounded number of listings, and a reader who browses
 * fifty of them should not be quietly handed fifty megabytes of storage they
 * did not ask for. The oldest entry goes when the cap is reached.
 */
const MAX_PAGES = 40;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      // `reload` so the install never picks the offline page out of the HTTP
      // cache — installing a worker around a stale copy of the one page that
      // exists to be correct when everything else is stale.
      await shell.add(new Request(OFFLINE_URL, { cache: "reload" }));
    })()
  );
  // No skipWaiting here on purpose. A worker that takes over mid-session can
  // hand the running page assets from a build it was not made with. The new
  // one waits, the page offers the reader a reload, and SKIP_WAITING below is
  // what they press.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Faster first paint on a navigation: the browser starts the network
      // request in parallel with waking this worker up, instead of after it.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }

      const keep = new Set([SHELL, PAGES, ASSETS]);
      const names = await caches.keys();
      await Promise.all(names.map((name) => (keep.has(name) ? null : caches.delete(name))));

      await self.clients.claim();
    })()
  );
});

/** The page asking to be swapped onto this worker now — the reader pressed
 *  "reload" on the update strip. */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Anything that changes state on the server is between the page and the
  // server. This worker has no opinion about it.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Folio's own API: prices, trade history, the JSON-RPC relay. Straight to the
  // network, every time, and nothing kept. See the note at the top.
  if (url.pathname.startsWith("/api/")) return;

  // A range request is a media player asking for bytes 40000-80000 of
  // something. Cache.put refuses a 206 and the player breaks in ways that are
  // hard to trace back to here, so it goes to the network untouched.
  if (request.headers.has("range")) return;

  if (request.mode === "navigate") {
    event.respondWith(page(event));
    return;
  }

  // Hashed by the build, so a URL that exists at all is a URL whose content can
  // never change. This is the one place it is safe to answer without asking.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(immutable(request));
    return;
  }

  event.respondWith(revalidating(request));
});

/**
 * A page: the network, then whatever we have, then the apology.
 *
 * The cached copy is written on the way past, which is what makes a second
 * visit to a listing survive a tunnel. It is never *preferred* to the network,
 * because a listing carries a price.
 */
async function page(event) {
  const cache = await caches.open(PAGES);

  try {
    const preloaded = await event.preloadResponse;
    const response = preloaded || (await fetch(event.request));

    // Only a clean answer is worth keeping. A 404 or a 500 cached here would
    // outlive the deploy that produced it.
    if (response && response.ok && response.type === "basic") {
      await put(cache, event.request, response.clone(), MAX_PAGES);
    }
    return response;
  } catch {
    const hit = await cache.match(event.request, { ignoreSearch: true });
    if (hit) return hit;

    const offline = await caches.match(OFFLINE_URL, { cacheName: SHELL });
    if (offline) return offline;

    // The worker was installed but the offline page is somehow not in it.
    // Better a plain, honest response than a promise rejection the browser
    // renders as its own network error page.
    return new Response("Folio is offline, and so is this fallback.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

/** Build output. Cached on first sight and answered from cache thereafter. */
async function immutable(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
  }
  return response;
}

/**
 * Everything else same-origin: answered from cache immediately, replaced in the
 * background.
 *
 * The reader gets last visit's copy of an icon or an avatar and this visit's
 * copy is waiting for them next time, which is the right trade for things whose
 * being a few hours old costs nothing.
 */
async function revalidating(request) {
  const cache = await caches.open(ASSETS);
  const hit = await cache.match(request);

  const network = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === "basic") {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);

  if (hit) return hit;

  const response = await network;
  if (response) return response;

  throw new Error(`Offline, and ${request.url} is not cached.`);
}

/** Write to a cache, then trim it back to its cap oldest-first. */
async function put(cache, request, response, max) {
  await cache.put(request, response);

  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) {
    await cache.delete(keys[i]);
  }
}
