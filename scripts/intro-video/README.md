# The Folio intro film

A 78-second introduction to Folio: what it is, how a launch works, what the
curve does, what holds the promises up, and — last, not buried — that the money
is real.

It is built out of the same things the site is: `app/globals.css`'s palette,
the three faces `app/layout.tsx` self-hosts, the mark from `components/Logo.tsx`,
hairline rules and square corners. Nothing in it is a stock template, and
nothing in it claims anything the site does not.

```
scripts/intro-video/
  intro.html                 the film
  render.mjs                 renders it to MP4
  folio-intro.mp4            the render (1920×1080, 30 fps, no audio)
  folio-intro-poster.jpg     a still, for a <video poster>
  README.md                  this file, and the narration below
```

## Rendering it

```
node scripts/intro-video/render.mjs
```

Needs Playwright with a Chromium, and an ffmpeg that can encode H.264.
Playwright's own bundled ffmpeg **cannot** — it is a VP8-only build — so the
script looks for a real one on `PATH`, then `ffmpeg-static`, then falls back to
asking you for `--ffmpeg <path>`. Neither tool is a dependency of the site, so
neither is in `package.json`: install what you are missing when you actually
want to re-render.

```
node scripts/intro-video/render.mjs --scale 0.5 --fps 24    # fast proof
node scripts/intro-video/render.mjs --start 39 --end 51.5   # one scene
node scripts/intro-video/render.mjs --out /tmp/folio.mp4 --crf 18
```

| flag | default | what it does |
| --- | --- | --- |
| `--fps` | `30` | frames per second |
| `--scale` | `1` | output size as a fraction of 1920×1080 — rasterisation only, never a reflow |
| `--crf` | `18` | x264 quality; lower is bigger. The committed file is 21 |
| `--start`, `--end` | whole film | render a slice, in seconds |
| `--poster`, `--poster-at` | — | also write a still, at `t` seconds |
| `--ffmpeg` | auto | path to an H.264-capable ffmpeg |

The typefaces are fetched from Google Fonts on the first run and cached in
`.cache/` (git-ignored). Half a megabyte of base64 does not belong in the tree.

## Editing it

Open `intro.html` in a browser and it plays on a `requestAnimationFrame`
clock, so you can iterate without rendering anything.

There is not one CSS transition or `@keyframes` rule in the file, and that is
deliberate. Every animated property is written by `seek(t)` — the film is a
pure function of one number — which is what lets the renderer step frame by
frame and get an identical file on a slow machine and a fast one. Recording a
self-animating page would capture whatever the screenshot loop happened to
catch. So: **if you add motion, drive it from `seek`, not from CSS.**

The shape of it:

- `SCENES` is the cut list — id, in-point, duration. `seek` shows exactly the
  one scene that owns `t` and calls its renderer with scene-local time.
- `R.s1` … `R.s8` are those renderers. Each is plain arithmetic over `seg(t, a, b)`,
  which is normalised progress through a window, clamped at both ends.
- `CAPTIONS` is the narration, timed against the *film's* clock rather than a
  scene's, so a line can hold across a cut the way a voice does. `width` keeps
  a caption clear of whatever is on screen beside it; `invert` flips it to
  paper-on-ink for the dark frame.
- `rise`, `riseEach`, `words` and `chars` are the only entrances the film has.
  One vocabulary, used everywhere.

Two easings and no more — `easeOut` for anything entering, `easeInOut` for
anything that both starts and stops on screen.

## No audio

The file has no sound track, and the narration is on the glass instead. That
is a deliberate default: an intro that autoplays muted on a landing page is the
common case, and burnt-in captions read in that case where a voice-over does
not.

If you want a voice-over, the caption text below **is** the script — it is
timed and it fits. Record it, then mux it in:

```
ffmpeg -i folio-intro.mp4 -i vo.wav -c:v copy -c:a aac -b:a 192k \
       -shortest folio-intro-vo.mp4
```

If you add a voice track, delete the captions from `CAPTIONS` and re-render
rather than shipping both — read-and-heard at once is worse than either.

### The narration, as timed

| in | out | line |
| --- | --- | --- |
| 0:08.2 | 0:14.9 | Most tokens arrive as a ticker, a supply, and somebody's word for it. |
| 0:16.4 | 0:25.6 | Folio starts from the other end: the listing is an article, and the token is minted out of the page. |
| 0:27.4 | 0:38.2 | Publishing calls the factory once. What comes back is an ERC20 that is also its own bonding-curve market maker. |
| 0:39.8 | 0:50.6 | Holders buy from the curve and sell straight back into its reserve. No pool to seed, no counterparty to find. |
| 0:52.4 | 1:02.4 | The promises are kept where a component cannot skip them — in row-level security, and in the contract itself. |
| 1:03.8 | 1:09.4 | And the part no intro should bury: this is a mainnet, and the money is real. |

## The cut

| | in | scene | on screen |
| --- | --- | --- | --- |
| 1 | 0:00 | Masthead | The mark draws itself, `FOLIO`, *Every token, told as a story* |
| 2 | 0:07.5 | The usual launch | A ticker, a supply and a promise — struck through |
| 3 | 0:15.5 | The listing *is* the article | A published piece, verified byline, price quoted at its foot |
| 4 | 0:26.5 | How a launch works | Four steps, one transaction |
| 5 | 0:39 | The market | The bonding curve drawn, a live quote, the reserve, then the sell leg |
| 6 | 0:51.5 | What holds it up | Bylines, articles, trades |
| 7 | 1:03 | Real money | The one inverted frame in the film |
| 8 | 1:10 | Outro | Mark, wordmark, *Launch a token* |

## What it claims

Everything said in it is something the repository already does, and it is worth
keeping that true as the film is edited:

- The listing is the article, and the token is minted from it — `app/create`.
- One call to the factory clones an ERC20 that is its own bonding-curve market
  maker; the address is read from the `TokenCreated` receipt — `README.md`,
  *How a launch works*.
- A launch costs its creator nothing but gas: no listing fee, no pool to seed.
- Bylines are proved by an EIP-4361 signature and enforced by the insert policy
  in `lib/schema.sql`; anything else renders as an unverified byline.
- Articles cannot be updated or deleted by any client; second thoughts are
  appended, dated and signed, and cannot be withdrawn.
- Slippage floors become `minTokensOut` / `minEthOut` on chain; the opening
  window caps each wallet and refunds the overage in the same transaction;
  selling back is closed only by the platform emergency stop.
- Folio settles on Robinhood Chain, in real ETH, with no test network and no
  practice mode.

Scene 7 is not a disclaimer bolted on the end — it is in the film because the
site says the same thing on `/about`, and an intro that left it out would be
selling something the product refuses to sell.

The article, ticker, price and address shown on screen are invented for the
film. `$MOON` and `0x8f3c…21ab` are not a real launch, and nothing in the film
shows a price anyone paid.
