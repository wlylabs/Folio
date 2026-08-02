/**
 * The wallet picker's icons, which have to stop asking eventually.
 *
 * `lib/walletDirectory.ts` takes AppKit's per-page icon prefetch out so a page
 * of forty wallet *names* is not held back by twenty pictures. That leaves the
 * grid tiles fetching their own icons — and AppKit's tile does that without a
 * `catch`, so a single failed request leaves it shimmering for as long as the
 * modal is open. `unstickWalletDirectoryIcons` wraps the one function all those
 * requests go through and makes it well-behaved: cached, de-duplicated, capped,
 * retried, and above all never rejecting.
 *
 * These are that wrapper's cases, driven against the real controller object the
 * modal uses, with only the network at the bottom replaced.
 *
 *   npm run test:web
 */

import test from "node:test";
import assert from "node:assert/strict";

const { ApiController, AssetController } = await import("@reown/appkit-controllers");

/** What the wrapper is standing in front of, in place of a real request. */
let icons;

/** Every id the wrapper actually asked the network for, in order. */
let asked;

/** How many requests were in the air at once, at the highest. */
let peak;
let live;

ApiController._fetchWalletImage = async (imageId) => {
  asked.push(imageId);
  live += 1;
  peak = Math.max(peak, live);
  try {
    await icons(imageId, asked.filter((id) => id === imageId).length);
  } finally {
    live -= 1;
  }
};

const stock = ApiController._fetchWalletImage;

// `typeof window` is the wrapper's own guard against running on a server, and
// this file is the closest thing to a browser it will meet.
globalThis.window = globalThis.window ?? {};

const { unstickWalletDirectoryIcons } = await import("../lib/walletDirectory.ts");

unstickWalletDirectoryIcons();

// The patch lands behind a dynamic import, so it is not in place on the line
// after the call. Wait for the swap rather than guessing at a delay.
for (let tries = 0; ApiController._fetchWalletImage === stock && tries < 100; tries += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

assert.notEqual(ApiController._fetchWalletImage, stock, "the wrapper never went on");

const fetchIcon = ApiController._fetchWalletImage;

/** A failure shaped like the one `FetchUtil` throws for a given status. */
function httpError(status) {
  const error = new Error(`HTTP status code: ${status}`);
  error.cause = { status };
  return error;
}

/** A fresh slate: no cached icons, no history, no default failure. */
function reset() {
  for (const key of Object.keys(AssetController.state.walletImages)) {
    delete AssetController.state.walletImages[key];
  }
  asked = [];
  peak = 0;
  live = 0;
  icons = async () => undefined;
}

test("an icon already in the cache costs no request", async () => {
  reset();
  AssetController.state.walletImages["cached"] = "blob:already-here";

  await fetchIcon("cached");

  assert.deepEqual(asked, []);
});

test("tiles sharing an icon share one request", async () => {
  reset();
  let release;
  icons = () => new Promise((resolve) => (release = resolve));

  const tiles = [fetchIcon("shared"), fetchIcon("shared"), fetchIcon("shared")];
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(asked, ["shared"], "the same icon was fetched more than once");

  release();
  await Promise.all(tiles);
});

test("a later tile asks again rather than joining a finished request", async () => {
  reset();
  await fetchIcon("gone");
  await fetchIcon("gone");

  // Nothing was cached — the request produced no image — so the second tile is
  // entitled to its own try rather than a resolved promise from the first.
  assert.deepEqual(asked, ["gone", "gone"]);
});

test("a rate limit is tried again, and the icon arrives", async () => {
  reset();
  icons = async (imageId, attempt) => {
    if (attempt === 1) throw httpError(429);
    AssetController.state.walletImages[imageId] = "blob:second-time";
  };

  await fetchIcon("busy");

  assert.deepEqual(asked, ["busy", "busy"]);
  assert.equal(AssetController.state.walletImages["busy"], "blob:second-time");
});

test("a connection that never answered is tried again", async () => {
  reset();
  icons = async (imageId, attempt) => {
    // No `cause`, which is what a fetch that never reached the host throws.
    if (attempt === 1) throw new TypeError("Failed to fetch");
    AssetController.state.walletImages[imageId] = "blob:back-online";
  };

  await fetchIcon("offline");

  assert.deepEqual(asked, ["offline", "offline"]);
});

test("an icon the directory does not have is not asked for twice", async () => {
  reset();
  icons = async () => {
    throw httpError(404);
  };

  await fetchIcon("missing");

  assert.deepEqual(asked, ["missing"], "a 404 was retried");
});

test("a failure that never passes still resolves, so the tile stops shimmering", async () => {
  reset();
  icons = async () => {
    throw httpError(500);
  };

  // The assertion is that this line is reached at all: AppKit's tile awaits
  // this call with no `catch`, and a rejection here is a tile that renders its
  // shimmer and nothing else for the life of the modal.
  await fetchIcon("broken");

  assert.equal(asked.length, 3, "the two retries were not both spent");
  assert.equal(AssetController.state.walletImages["broken"], undefined);
});

test("a screenful of tiles becomes a queue rather than a burst", async () => {
  reset();
  icons = () => new Promise((resolve) => setTimeout(resolve, 5));

  const screenful = Array.from({ length: 24 }, (_, index) => fetchIcon(`wallet-${index}`));
  await Promise.all(screenful);

  assert.equal(asked.length, 24, "some tile was dropped on the way through");
  assert.ok(peak <= 6, `${peak} icon requests were in the air at once`);
  assert.ok(peak > 1, "the requests were serialised, which is slower than it needs to be");
});
