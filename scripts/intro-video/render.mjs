#!/usr/bin/env node
/**
 * Renders scripts/intro-video/intro.html to an MP4.
 *
 * The page animates from a single `seek(t)` function and nothing else — no CSS
 * transitions, no wall clock — so this script does not "record" anything. It
 * steps the film one frame at a time, screenshots each position and pipes the
 * JPEGs straight into ffmpeg. A slow machine produces exactly the same file as
 * a fast one; it just takes longer.
 *
 *   node scripts/intro-video/render.mjs
 *   node scripts/intro-video/render.mjs --fps 30 --scale 0.5 --out /tmp/preview.mp4
 *   node scripts/intro-video/render.mjs --start 39 --end 51.5     # one scene
 *
 * Requirements: Playwright with a Chromium, and an ffmpeg that can encode
 * H.264. Both are looked up in a few likely places — see `findChromium` and
 * `findFfmpeg` — and the script says which one it is using before it starts.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, ".cache");

/* -------------------------------------------------------------------------- */
/* Arguments                                                                  */
/* -------------------------------------------------------------------------- */

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else out[key] = next, i++;
  }
  return out;
}

const opts = args(process.argv.slice(2));
const FPS = Number(opts.fps ?? 30);
const SCALE = Number(opts.scale ?? 1);
const QUALITY = Number(opts.quality ?? 94);
const CRF = Number(opts.crf ?? 18);
const OUT = path.resolve(
  opts.out ?? path.join(HERE, opts.cut === "short" ? "folio-intro-short.mp4" : "folio-intro.mp4")
);
const POSTER = opts.poster ? path.resolve(opts.poster) : null;
const POSTER_AT = Number(opts["poster-at"] ?? 4.6);
/** A sound track to mux in — score.mjs's output, or a recorded voice. */
const AUDIO = opts.audio ? path.resolve(String(opts.audio)) : null;
/** Burnt-in captions. Off under a voice: see `SHOW_CAPTIONS` in intro.html. */
const CAPTIONS = !opts["no-captions"];
/** Which cut to render: the 78-second film, or the 27-second one. */
const CUT = opts.cut === "short" ? "short" : "full";

/* -------------------------------------------------------------------------- */
/* Fonts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The three faces app/layout.tsx self-hosts, fetched once and cached as a
 * base64 stylesheet. They are not committed: half a megabyte of base64 in the
 * tree to render a file that is itself an artefact is a bad trade, and this
 * takes about two seconds on a cold run.
 *
 * Only the `latin` subsets are kept — the film has no Cyrillic or Greek in it —
 * and the `unicode-range` goes with them, so a face is never skipped for a
 * character the subset happens not to declare.
 */
const FONT_CSS_URL =
  "https://fonts.googleapis.com/css2" +
  "?family=Playfair+Display:wght@400;700;900" +
  "&family=PT+Serif:ital,wght@0,400;0,700;1,400" +
  "&family=Inter:wght@400;500;600;700" +
  "&display=block";

async function embeddedFonts() {
  const cached = path.join(CACHE, "fonts.css");
  if (fs.existsSync(cached)) return fs.readFileSync(cached, "utf8");

  console.log("· fetching webfonts (first run only)…");
  // Google serves woff2 only to a browser-shaped UA; anything else gets ttf.
  const res = await fetch(FONT_CSS_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Google Fonts returned ${res.status}`);
  const css = await res.text();

  // css2 emits one commented @font-face block per subset.
  const blocks = css.split("/*").slice(1).map((c) => "/*" + c);
  const latin = blocks.filter((b) => b.startsWith("/* latin */"));
  if (!latin.length) throw new Error("no latin subsets in the Google Fonts response");

  let out = "";
  for (const block of latin) {
    const url = block.match(/url\((https:[^)]+)\)/)?.[1];
    if (!url) continue;
    const font = Buffer.from(await (await fetch(url)).arrayBuffer());
    out +=
      block
        .replace(/url\(https:[^)]+\)/, `url(data:font/woff2;base64,${font.toString("base64")})`)
        .replace(/^\/\*[^*]*\*\/\s*/, "")
        .replace(/unicode-range:[^;]+;\s*/, "")
        .trim() + "\n";
  }

  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, out);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

const require_ = createRequire(import.meta.url);

/** Playwright, from the project or from a global install. */
function loadPlaywright() {
  const candidates = [
    "playwright",
    "playwright-core",
    "/opt/node22/lib/node_modules/playwright",
    "/usr/lib/node_modules/playwright",
  ];
  for (const id of candidates) {
    try {
      return require_(id);
    } catch {
      /* keep looking */
    }
  }
  throw new Error(
    "Playwright not found. `npm i -D playwright` in this repo, or install it globally."
  );
}

/** An ffmpeg that can encode H.264. Playwright ships one that cannot. */
function findFfmpeg() {
  const tries = [];
  if (opts.ffmpeg) tries.push(String(opts.ffmpeg));
  try {
    tries.push(require_("ffmpeg-static"));
  } catch {
    /* optional */
  }
  tries.push("ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg");
  for (const bin of tries) {
    if (!bin) continue;
    const r = spawnSyncQuiet(bin, ["-hide_banner", "-encoders"]);
    if (r && r.includes("libx264")) return bin;
  }
  throw new Error(
    "No H.264-capable ffmpeg found. Install one (`apt install ffmpeg`, `npm i -D ffmpeg-static`) or pass --ffmpeg <path>."
  );
}

function spawnSyncQuiet(bin, argv) {
  try {
    const { spawnSync } = require_("node:child_process");
    const r = spawnSync(bin, argv, { encoding: "utf8" });
    return r.status === 0 ? `${r.stdout}${r.stderr}` : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Render                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  const { chromium } = loadPlaywright();
  const ffmpeg = findFfmpeg();
  const fonts = await embeddedFonts();

  const W = Math.round(1920 * SCALE);
  const H = Math.round(1080 * SCALE);

  const browser = await chromium.launch({
    args: [
      // Deterministic paint: no throttling of a page nobody is looking at, and
      // no partial rasterisation racing the screenshot.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
      "--hide-scrollbars",
    ],
  });

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    // The stage is authored at 1920×1080; a smaller output is the same layout
    // rasterised smaller, never a reflow.
    deviceScaleFactor: SCALE,
  });

  // Told before the document runs, so the page never starts its own clock —
  // and knows whether this cut carries its narration on the glass.
  await page.addInitScript(({ captions, cut }) => {
    window.FOLIO_MANUAL = true;
    window.FOLIO_CAPTIONS = captions;
    window.FOLIO_CUT = cut;
  }, { captions: CAPTIONS, cut: CUT });

  await page.goto("file://" + path.join(HERE, "intro.html"), { waitUntil: "load" });
  await page.evaluate((css) => {
    document.getElementById("fonts").textContent = css;
  }, fonts);
  await page.evaluate(() => document.fonts.ready);
  // One layout pass with the real faces in place before anything is measured.
  await page.evaluate(() => window.seek(0));

  const duration = await page.evaluate(() => window.FOLIO_DURATION);
  const start = Number(opts.start ?? 0);
  const end = Math.min(Number(opts.end ?? duration), duration);
  const frames = Math.round((end - start) * FPS);

  console.log(`· chromium ${browser.version()}`);
  console.log(`· ffmpeg   ${ffmpeg}`);
  if (AUDIO) console.log(`· audio    ${AUDIO}`);
  console.log(
    `· ${W}×${H} · ${FPS} fps · ${(end - start).toFixed(1)}s · ${frames} frames` +
      (CUT === "short" ? " · short cut" : "") +
      (CAPTIONS ? "" : " · no captions")
  );

  if (AUDIO && !fs.existsSync(AUDIO)) throw new Error(`No such audio file: ${AUDIO}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  // The track is on the film's clock, so a slice of the film takes the same
  // slice of it — seeking the audio input rather than the output keeps the two
  // in step when --start is used to render one scene.
  const audioIn = AUDIO
    ? [...(start ? ["-ss", String(start)] : []), "-i", AUDIO]
    : [];
  const audioOut = AUDIO
    ? ["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-shortest"]
    : [];

  const enc = spawn(
    ffmpeg,
    [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-f", "image2pipe",
      "-framerate", String(FPS),
      "-i", "-",
      ...audioIn,
      ...audioOut,
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", String(CRF),
      "-pix_fmt", "yuv420p",
      // Wide compatibility: this file gets dropped into a site, a deck and a
      // phone, and High/4.0 plays everywhere any of those do.
      "-profile:v", "high",
      "-level", "4.0",
      "-movflags", "+faststart",
      "-r", String(FPS),
      OUT,
    ],
    { stdio: ["pipe", "inherit", "inherit"] }
  );

  const done = new Promise((resolve, reject) => {
    enc.on("error", reject);
    enc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))
    );
  });

  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    const t = start + i / FPS;
    await page.evaluate((tt) => window.seek(tt), t);
    const shot = await page.screenshot({ type: "jpeg", quality: QUALITY });
    if (!enc.stdin.write(shot)) {
      await new Promise((r) => enc.stdin.once("drain", r));
    }
    if (i % Math.max(1, Math.round(FPS * 2)) === 0 || i === frames - 1) {
      const pct = ((i + 1) / frames) * 100;
      const rate = (i + 1) / ((Date.now() - t0) / 1000);
      const eta = (frames - i - 1) / Math.max(rate, 0.001);
      process.stdout.write(
        `\r  ${pct.toFixed(1).padStart(5)}%  ${(i + 1)}/${frames}  ${rate.toFixed(1)} fps  eta ${eta.toFixed(0)}s   `
      );
    }
  }
  process.stdout.write("\n");

  enc.stdin.end();
  await done;

  if (POSTER) {
    await page.evaluate((tt) => window.seek(tt), POSTER_AT);
    fs.mkdirSync(path.dirname(POSTER), { recursive: true });
    await page.screenshot({ path: POSTER, type: "jpeg", quality: 92 });
    console.log(`· poster   ${POSTER} (t=${POSTER_AT}s)`);
  }

  await browser.close();

  const size = fs.statSync(OUT).size;
  console.log(`· wrote    ${OUT} (${(size / 1e6).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error("\n" + (err?.stack || String(err)));
  process.exit(1);
});
