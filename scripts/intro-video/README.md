# The Folio intro film

A 27-second introduction to Folio: what it is, what the curve does, that the
money is real, and where to go.

It is built out of the same things the site is: `app/globals.css`'s palette,
the three faces `app/layout.tsx` self-hosts, the mark from `components/Logo.tsx`,
hairline rules and square corners. Nothing in it is a stock template, and
nothing in it claims anything the site does not.

It ships silent, with the narration burnt in as captions — which is the case a
pre-roll, a post or a hero video actually gets: autoplaying muted, where text
reads and sound is not there to be heard. A track can be muxed in whenever
there is one worth muxing: `render.mjs --audio`.

```
scripts/intro-video/
  intro.html                 the material: eight scenes, and the cuts made of them
  render.mjs                 renders a cut to MP4
  folio-intro-short.mp4      27.6s · 1920×1080 · 30 fps · captions · silent
  folio-intro-poster.jpg     a still, for a <video poster>
  README.md                  this file, and the narration below
```

`intro.html` still holds all eight scenes and the 78-second assembly of them,
because the short cut is made out of that material and re-cutting is a cut list
rather than a rewrite. Nothing renders the long film unless it is asked for by
name — `--cut full` — and it is not committed.

## Rendering it

```
node scripts/intro-video/render.mjs
```

That writes `folio-intro-short.mp4`: the cut that ships.

Needs Playwright with a Chromium, and an ffmpeg that can encode H.264.
Playwright's own bundled ffmpeg **cannot** — it is a VP8-only build — so the
script looks for a real one on `PATH`, then `ffmpeg-static`, then falls back to
asking you for `--ffmpeg <path>`. Neither tool is a dependency of the site, so
neither is in `package.json`: install what you are missing when you actually
want to re-render.

```
node scripts/intro-video/render.mjs --scale 0.5 --fps 24    # fast proof
node scripts/intro-video/render.mjs --start 14 --end 19.2   # one scene
node scripts/intro-video/render.mjs --cut full             # the 78-second film
node scripts/intro-video/render.mjs --audio track.wav      # with a sound track
node scripts/intro-video/render.mjs --out /tmp/folio.mp4 --crf 18
```

| flag | default | what it does |
| --- | --- | --- |
| `--fps` | `30` | frames per second |
| `--scale` | `1` | output size as a fraction of 1920×1080 — rasterisation only, never a reflow |
| `--crf` | `18` | x264 quality; lower is bigger. The committed file is 21 |
| `--start`, `--end` | whole film | render a slice, in seconds |
| `--poster`, `--poster-at` | — | also write a still, at `t` seconds |
| `--cut` | `short` | `full` renders the 78-second film from the same material |
| `--no-captions` | off | leave the narration off the glass — for a voiced cut |
| `--audio` | — | a track to mux in as AAC; sliced with `--start` so it stays in step |
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
- `SHOW_CAPTIONS` decides whether they are drawn at all. `?captions=0` in the
  browser, `--no-captions` under the renderer — for the case where a voice is
  carrying the narration instead.
- `SHORT` and `SHORT_CAPTIONS` are the advertisement, and `CUT` picks between
  them and the full film. `?cut=short` in the browser, `--cut short` under the
  renderer.
- `rise`, `riseEach`, `words` and `chars` are the only entrances the film has.
  One vocabulary, used everywhere.

Two easings and no more — `easeOut` for anything entering, `easeInOut` for
anything that both starts and stops on screen.

## The cut that ships

27.6 seconds, five scenes, two captions.

It is not the long film trimmed, and it is not a montage of clips either. Every
segment in `SHORT` names a scene and a window inside that scene's own clock,
and the renderer is handed `from + dur` as that scene's length — so the scene
plays its own exit where the segment ends instead of being cut off mid-move.
Nothing in it is a shortened animation; it is the same animations, fewer of
them, each played whole.

| | in | scene | what it is there for |
| --- | --- | --- | --- |
| 1 | 0:00 | Masthead | The mark, the wordmark, the promise |
| 2 | 0:05 | The listing *is* the article | The claim, proved on screen: verified byline, price at the foot |
| 3 | 0:14 | The market | The curve quotes both sides |
| 4 | 0:19.2 | Real money | It is a mainnet, said plainly |
| 5 | 0:22 | Outro | The mark, and *Launch a token* |

What it leaves out is elaboration — the usual launch struck through, the four
steps of a launch, the three things that hold the promises up. Those scenes are
still in `intro.html`; they are simply not in this cut. What it keeps is
everything needed to know what Folio is and what it costs you to be wrong about
it. Scene 4 is in there on purpose: an advertisement is exactly where a claim
about real money is most tempting to leave out, and `/about` does not leave it
out either.

One thing is handled specially. Scene 7's lede is three sentences of risk, and
three seconds is not enough to read them, so the cut hides the paragraph rather
than flashing it unread — `hide: ".lede"` on that segment. The headline carries
it alone.

The captions are two lines instead of six, and both scenes they sit under have
headlines of their own. An advertisement that talks over its own pictures is
worse than one that trusts them.

## Sound

There is none, and that is a position rather than an omission. The film plays
where video autoplays muted — a post, a pre-roll, the top of a page — so the
captions carry the narration and nothing is lost with the sound off.

Two attempts at giving it a sound track are in the history rather than in the
tree: a synthesised voice-over reading the captions (commit `919f58a`) and a
synthesised score (`c5bc431`, thinned in `7689ba1`). Both were written from
scratch to avoid licensing anything, and both were rejected for the reason
worth writing down here: **synthesised audio does not sound like the film looks.**
The pictures are precise and the sound was approximate, and on a piece whose
whole argument is that the writing matters, approximate reads as cheap. If they
are ever useful again, `git show` has them.

So the next track should be a real one — recorded, or licensed, or both — and
muxing it in is one command:

```
node scripts/intro-video/render.mjs --audio track.wav --crf 21
```

or, without re-rendering the picture at all:

```
ffmpeg -i folio-intro-short.mp4 -i track.wav -map 0:v:0 -map 1:a:0 \
       -c:v copy -c:a aac -b:a 160k -ac 2 -movflags +faststart -shortest out.mp4
```

Two things to get right when one arrives. It has to end at 27.6 seconds, not
near it — the picture decides how long the file is, so anything still ringing
at the cut is chopped rather than faded. And it should sit around -18 LUFS with
a true peak under -1.5 dBFS, which is where the rest of the web is mixed.

If a recorded voice ever carries the narration instead of the captions, render
with `--no-captions` as well: read and heard at once is worse than either.

### The long film's narration, as timed

These are the six captions of the 78-second assembly — `CAPTIONS` in
`intro.html`, which `--cut full` still plays. The cut that ships carries two of
its own, in `SHORT_CAPTIONS`.

| in | out | line |
| --- | --- | --- |
| 0:08.2 | 0:14.9 | Most tokens arrive as a ticker, a supply, and somebody's word for it. |
| 0:16.4 | 0:25.6 | Folio starts from the other end: the listing is an article, and the token is minted out of the page. |
| 0:27.4 | 0:38.2 | Publishing calls the factory once. What comes back is an ERC20 that is also its own bonding-curve market maker. |
| 0:39.8 | 0:50.6 | Holders buy from the curve and sell straight back into its reserve. No pool to seed, no counterparty to find. |
| 0:52.4 | 1:02.4 | The promises are kept where a component cannot skip them — in row-level security, and in the contract itself. |
| 1:03.8 | 1:09.4 | And the part no intro should bury: this is a mainnet, and the money is real. |

*In* is where a caption arrives and *out* is where it goes. A caption holds
long enough to be read, which is a good deal longer than its line takes to say
— so a recorded read starting on the in-point has room to spare, and does not
need to fill it.

## The long film, scene by scene

What `--cut full` assembles out of the same eight scenes. It is not committed
as a file; this is the record of what it is, for whoever re-cuts next.

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
