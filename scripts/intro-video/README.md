# The Folio intro film

A 78-second introduction to Folio: what it is, how a launch works, what the
curve does, what holds the promises up, and — last, not buried — that the money
is real.

It is built out of the same things the site is: `app/globals.css`'s palette,
the three faces `app/layout.tsx` self-hosts, the mark from `components/Logo.tsx`,
hairline rules and square corners. Nothing in it is a stock template, and
nothing in it claims anything the site does not.

It ships in two cuts of the same film. The silent one carries the narration as
burnt-in captions, for the hero-video case where the browser autoplays muted;
the voiced one carries it as a voice-over and drops the captions, for the case
where somebody is actually listening.

```
scripts/intro-video/
  intro.html                 the film
  render.mjs                 renders it to MP4
  narrate.mjs                speaks the narration and lays it on the film's clock
  folio-intro.mp4            the silent cut (1920×1080, 30 fps, captions, no audio)
  folio-intro-vo.mp4         the voiced cut (same picture, no captions, AAC narration)
  folio-intro-poster.jpg     a still, for a <video poster> — serves both cuts
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
| `--no-captions` | off | leave the narration off the glass — for the voiced cut |
| `--audio` | — | a WAV to mux in as AAC; sliced with `--start` so it stays in step |
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
  paper-on-ink for the dark frame. It is also the script `narrate.mjs` speaks,
  which it reads out of this file — so keep it a plain literal of plain values,
  and re-run the narration after editing a line.
- `SHOW_CAPTIONS` decides whether they are drawn at all. `?captions=0` in the
  browser, `--no-captions` under the renderer.
- `rise`, `riseEach`, `words` and `chars` are the only entrances the film has.
  One vocabulary, used everywhere.

Two easings and no more — `easeOut` for anything entering, `easeInOut` for
anything that both starts and stops on screen.

## The voice-over

`folio-intro.mp4` still has no sound track and still carries the narration as
captions, because an intro that autoplays muted on a landing page is the common
case and burnt-in text reads in that case where a voice does not.
`folio-intro-vo.mp4` is the same picture with the narration spoken and the
captions gone — read-and-heard at once is worse than either, so no cut ships
both. Use whichever the page you are embedding into deserves; they share a
poster, so swapping one for the other is one attribute.

There is no music under it. The voice is alone on the track, which is what the
film's pacing was cut for.

Making it is two commands:

```
node scripts/intro-video/narrate.mjs
node scripts/intro-video/render.mjs --no-captions \
     --audio scripts/intro-video/folio-intro-vo.wav \
     --out scripts/intro-video/folio-intro-vo.mp4 --crf 21
```

### What narrate.mjs does

The script is not written twice. `CAPTIONS` in `intro.html` **is** the
narration, and `narrate.mjs` lifts that array straight out of the file — so a
line reworded or a cue moved changes both cuts at once, and the two can't
drift. Each line is synthesised, then placed at its caption's in-point: the
voice starts where the caption would have appeared, and the silence between
lines is the silence the cut was already leaving.

It is spoken at a natural pace rather than stretched to fill the window. A
caption holds long enough to be *read*, which is a good deal longer than the
line takes to *say* — the six lines are 33 seconds of speech in a 78-second
film. `--rate` sets the pace; a line is only ever tightened, and only when it
would otherwise still be talking after its picture has gone.

The whole track is levelled once, at the end, to −16 LUFS with a −1.5 dBFS true
peak — the usual answer for speech on the web, and one pass over the assembled
timeline rather than per line, so the quiet lines stay quieter than the loud
ones.

| flag | default | what it does |
| --- | --- | --- |
| `--rate` | `1.1` | phoneme length; above 1 is slower |
| `--voice` | `en_US-ryan-high` | a Piper voice name, or a path to an `.onnx` |
| `--lead` | `0` | seconds the voice waits after its caption's in-point |
| `--lufs` | `-16` | integrated loudness target |
| `--out` | `folio-intro-vo.wav` | where to write |
| `--piper`, `--ffmpeg` | auto | paths, if they are not found |

Needs Piper (`pip install piper-tts`) and any ffmpeg — this one only moves PCM
around, so unlike the render it does not need an H.264 encoder. Neither is a
dependency of the site. The voice model is ~120 MB and is fetched once into
`.cache/` alongside the webfonts, for the same reason they are: it does not
belong in the tree.

Two things worth knowing about a synthesised read. The voice on the committed
cut is Piper's `en_US-ryan-high` — a synthesiser, not a person, and said here
rather than left to be assumed. And it is not bit-reproducible: the model
samples, so two runs differ slightly and re-running gives you a new take rather
than the old one back. The take that shipped therefore lives in
`folio-intro-vo.mp4`'s audio track, and the WAV beside it is not committed. To
re-render the picture against that same read rather than a fresh one, lift it
back out:

```
ffmpeg -i folio-intro-vo.mp4 -vn -c copy /tmp/vo.m4a    # then render.mjs --audio /tmp/vo.m4a
```

Where the synthesiser is simply wrong about a word, `SAY` in `narrate.mjs`
overrides the sound and never the sentence: `mainnet` is one word to a reader
and two to a speaker, and left alone it comes out "MAIN-it". Hyphenated
compounds are unglued for the same reason — "row-level" reads as "role-evel" —
and em dashes are kept, because they are heard as the pause they are.

### A recorded take

A human read needs none of the above. The caption text below is the script; it
is timed and it fits. Record it against the film's clock and mux it in:

```
node scripts/intro-video/render.mjs --no-captions --audio vo.wav \
     --out folio-intro-vo.mp4 --crf 21
```

or, without re-rendering the picture:

```
ffmpeg -i folio-intro.mp4 -i vo.wav -c:v copy -c:a aac -b:a 192k \
       -shortest folio-intro-vo.mp4
```

— though that one keeps the captions that are burnt into `folio-intro.mp4`,
which is exactly what you do not want under a voice. Re-render instead.

### The narration, as timed

| in | out | line |
| --- | --- | --- |
| 0:08.2 | 0:14.9 | Most tokens arrive as a ticker, a supply, and somebody's word for it. |
| 0:16.4 | 0:25.6 | Folio starts from the other end: the listing is an article, and the token is minted out of the page. |
| 0:27.4 | 0:38.2 | Publishing calls the factory once. What comes back is an ERC20 that is also its own bonding-curve market maker. |
| 0:39.8 | 0:50.6 | Holders buy from the curve and sell straight back into its reserve. No pool to seed, no counterparty to find. |
| 0:52.4 | 1:02.4 | The promises are kept where a component cannot skip them — in row-level security, and in the contract itself. |
| 1:03.8 | 1:09.4 | And the part no intro should bury: this is a mainnet, and the money is real. |

The *in* column is where the line starts in both cuts — where the caption
arrives in the silent one, where the voice does in the voiced one. *Out* is
where the caption goes, which is as late as a read may finish and later than
one needs to: the synthesised take at the default rate lands between 3.9 and
7.2 seconds a line, comfortably inside.

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
