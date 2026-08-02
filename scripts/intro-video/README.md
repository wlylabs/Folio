# The Folio intro film

A 78-second introduction to Folio: what it is, how a launch works, what the
curve does, what holds the promises up, and — last, not buried — that the money
is real.

It is built out of the same things the site is: `app/globals.css`'s palette,
the three faces `app/layout.tsx` self-hosts, the mark from `components/Logo.tsx`,
hairline rules and square corners. Nothing in it is a stock template, and
nothing in it claims anything the site does not.

One cut, and it serves both cases: the narration is burnt in as captions, so it
reads in the muted autoplay a landing page gives it, and there is a score under
it for anyone who turns the sound on. Nothing in the film is said twice.

```
scripts/intro-video/
  intro.html                 the film
  render.mjs                 renders it to MP4
  score.mjs                  writes the music under it
  folio-intro.mp4            the render (1920×1080, 30 fps, captions, scored)
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
| `--no-captions` | off | leave the narration off the glass — for a voiced cut |
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
  paper-on-ink for the dark frame.
- `SHOW_CAPTIONS` decides whether they are drawn at all. `?captions=0` in the
  browser, `--no-captions` under the renderer — for the case where a voice is
  carrying the narration instead.
- `rise`, `riseEach`, `words` and `chars` are the only entrances the film has.
  One vocabulary, used everywhere.

Two easings and no more — `easeOut` for anything entering, `easeInOut` for
anything that both starts and stops on screen.

## The score

The film carries its narration as captions, because the case it is built for is
a hero video autoplaying muted, where text reads and a voice does not. That
leaves the sound with a different job: not to say anything, but to be
somewhere. So there is a score under it, quiet enough to be left on.

It is written the way the picture is — out of nothing borrowed. `score.mjs` is
two synthesised voices, a room to put them in, and a cue list; no sample, no
library, nothing that has to be licensed, and no track anybody has heard
before. It writes a 78-second stereo WAV, exactly the length of the film.

```
node scripts/intro-video/score.mjs
node scripts/intro-video/render.mjs --audio scripts/intro-video/folio-intro-score.wav --crf 21
```

The second command re-renders the picture as well, which takes a few minutes.
To put a new score under the picture that is already committed, mux instead —
the video stream is copied, not re-encoded, so the film is untouched:

```
ffmpeg -i folio-intro.mp4 -i folio-intro-score.wav -map 0:v:0 -map 1:a:0 \
       -c:v copy -c:a aac -b:a 160k -ac 2 -movflags +faststart -shortest out.mp4
```

Embedding it muted is still the right default on a landing page; the score is
for the person who turns it on, and `muted` on the `<video>` costs nothing.

### What is in it

D minor, and it stays there. Eight scenes of one argument do not want a
progression going somewhere — they want one harmony bending around a pedal. F
major for the two scenes that are Folio's own answer, B-flat with its third
taken out where the usual launch is struck through, D underneath everything
that carries weight.

Every cue answers a beat in `intro.html` rather than a bar line, and the cue
list says which: the sheet beginning to draw itself, the strike-through
crossing the promise, the byline earning its Verified chip, the four steps at
2.1 seconds apart. The one the film is really about is scene 5 — five notes
climb as the bonding curve is drawn, and the sell leg walks the same five back
down to exactly where the buy began. Scene 7, where the film says the money is
real, is the one place the score gets out of the way: two low notes and a lot
of room, and the quietest four seconds in the piece are the ones before it.

| flag | default | what it does |
| --- | --- | --- |
| `--lufs` | `-20` | integrated loudness. Music alone under a film sits below speech |
| `--out` | `folio-intro-score.wav` | where to write |
| `--ffmpeg` | auto | path to an ffmpeg — needed for the loudness pass only |

Three things in there are worth not undoing. The reverb send is high-passed
before the room, because sending low fundamentals into a 2.6-second decay is
what turns a chord bed into a drone. The pads are voiced above D3 and mixed
well under the struck notes, for the same reason. And the fade ends in silence
exactly at 78.0 seconds: the picture decides how long the file is, so anything
still ringing at the cut gets chopped rather than faded.

The WAV is not committed — it is 22 MB of PCM that `score.mjs` will write again
in about a minute, and the take that ships is inside the film's audio track.

### A voice instead

If somebody records the narration, the film can carry that instead: the caption
text below is the script, it is timed, and it fits.

```
node scripts/intro-video/render.mjs --no-captions --audio vo.wav --crf 21
```

`--no-captions` is what keeps the glass clear underneath it — read and heard at
once is worse than either. A synthesised read was tried here and thrown away;
it is not a thing to ship on a film whose whole argument is that the writing
matters.

### The narration, as timed

| in | out | line |
| --- | --- | --- |
| 0:08.2 | 0:14.9 | Most tokens arrive as a ticker, a supply, and somebody's word for it. |
| 0:16.4 | 0:25.6 | Folio starts from the other end: the listing is an article, and the token is minted out of the page. |
| 0:27.4 | 0:38.2 | Publishing calls the factory once. What comes back is an ERC20 that is also its own bonding-curve market maker. |
| 0:39.8 | 0:50.6 | Holders buy from the curve and sell straight back into its reserve. No pool to seed, no counterparty to find. |
| 0:52.4 | 1:02.4 | The promises are kept where a component cannot skip them — in row-level security, and in the contract itself. |
| 1:03.8 | 1:09.4 | And the part no intro should bury: this is a mainnet, and the money is real. |

*In* is where the caption arrives and *out* is where it goes. A caption holds
long enough to be read, which is a good deal longer than the line takes to say
— so a recorded read starting on the in-point has room to spare, and does not
need to fill it.

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
