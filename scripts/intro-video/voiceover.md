# The intro film — voice-over script

For `folio-intro.mp4` (78s). 141 words across about 62 seconds of speech,
which is roughly 135 words per minute — a read, not a pitch.

The film currently ships with the narration burnt in as captions. **A voice
track replaces those captions; it does not sit on top of them.** Read-and-heard
at once is worse than either, so before rendering a VO cut, empty `CAPTIONS` in
`intro.html`:

```js
const CAPTIONS = [];
```

…re-render, and mux the audio in:

```
node scripts/intro-video/render.mjs --out folio-intro-silent.mp4
ffmpeg -i folio-intro-silent.mp4 -i vo.wav \
       -c:v copy -c:a aac -b:a 192k -shortest folio-intro-vo.mp4
```

`folio-intro.srt` carries these same lines at these same times, for accessibility
captions on the VO cut or for a YouTube upload.

## Direction

The voice is the one the repository is written in: someone who built the thing,
explaining it to another builder over a table. Level, specific, unhurried.
Nothing is being sold.

- **Never rise at the end of a sentence.** Every line here lands.
- **No emphasis on the adjectives** — there are barely any, and the nouns are
  doing the work. Hit *article*, *factory*, *curve*, *reserve*, *mainnet*.
- **Leave the pauses in.** The gaps between lines are as long as the lines in
  places, and the film is doing something in every one of them.
- Lines 11 and 12 are the only place the read changes. They come after a hard
  cut to a black frame. Slower, quieter, no drama added — the sentence is
  already the point, and pushing it turns a disclosure into a threat.
- Line 13 (*"Folio."*) is a full stop, not an announcement.

Scene 1 is deliberately silent — the mark folding itself, the wordmark, the
tagline. If you need a voice from frame one, there is an alternate line at the
bottom, but the cold open is better.

## Pronunciation

| written | said |
| --- | --- |
| Folio | **FOH**-lee-oh |
| ERC-20 | "E-R-C twenty" |
| mainnet | "MAIN-net" — one word, stress the first |
| row-level security | "row" as in *a row of seats*, not *a row about the bill* |

## The script

Times are film timecode. "In" is where the first syllable lands.

| # | in | out | scene | line |
| --- | --- | --- | --- | --- |
| — | 0:00 | 0:07.5 | 1 · masthead | *(silent)* |
| 1 | 0:08.0 | 0:13.8 | 2 · the usual launch | Most tokens arrive the same way. A ticker, a supply, and somebody's word for it. |
| 2 | 0:16.2 | 0:20.8 | 3 · the article | Folio starts from the other end: the listing is the article. |
| 3 | 0:21.4 | 0:26.4 | 3 | Signed by its author, and priced at the foot of the page. |
| 4 | 0:27.3 | 0:29.0 | 4 · how a launch works | Publishing takes one transaction. |
| 5 | 0:29.4 | 0:34.4 | 4 | One call to the factory. No listing fee, no pool to seed. |
| 6 | 0:34.7 | 0:39.7 | 4 → 5 | What comes back is an ERC-20 that is its own market maker. |
| 7 | 0:40.4 | 0:45.8 | 5 · the market | Price comes off a bonding curve, quoted by the contract as you read. |
| 8 | 0:46.2 | 0:52.5 | 5 → 6 | Holders buy from it, and sell straight back into its reserve — no counterparty to find. |
| 9 | 0:53.0 | 0:58.0 | 6 · what holds it up | None of that is enforced by a component that could skip it. |
| 10 | 0:58.4 | 1:02.6 | 6 | It lives in row-level security, and in the contract itself. |
| 11 | 1:03.9 | 1:06.4 | 7 · real money | One thing an intro shouldn't bury. |
| 12 | 1:06.6 | 1:09.9 | 7 | This is a mainnet. The money is real. |
| 13 | 1:11.0 | 1:11.8 | 8 · outro | Folio. |
| 14 | 1:12.4 | 1:14.5 | 8 | Write the piece. Publish it. |
| 15 | 1:14.8 | 1:17.3 | 8 | Every token, told as a story. |

### Sync notes

Six lines are written to land on something. Missing these costs the film more
than a tenth of a second of drift does:

- **Line 3** — the *Verified* chip appears at 0:21.9 and the price at 0:22.9,
  so "signed" and "priced" arrive in that order under the words.
- **Line 6** crosses the cut at 0:39.0 on purpose. "…its own market maker"
  should be landing as the curve starts drawing itself.
- **Line 7** — the quote in the panel is counting up from 0:41.6 to 0:43.7,
  under "quoted by the contract".
- **Line 8** crosses the cut at 0:51.5, and "sell straight back" wants to be on
  0:47.4, where the panel flips to the sell leg and the marker turns red and
  walks back down the curve.
- **Line 11** waits for the black. The cut is at 1:03.0; do not come in early.
- **Line 15** rides the final fade, which starts at 1:16.4.

Everything else can breathe where it likes.

## Alternate cold open

Only if a silent first seven seconds is not an option. It goes over the mark
drawing itself, which means it competes with the one moment in the film that is
purely a logo — that is the cost.

> **0:03.8 → 0:06.6** — A folio is one sheet, folded once.

If you use it, push line 1 to 0:08.6 so the two do not run together.

## Recording

- Mono, 48 kHz, 24-bit WAV. One take per line is fine — the timings above are a
  target, not a constraint on how you record.
- Leave 20–30 seconds of room tone; the gaps between lines are long and silence
  that changes texture between them is audible.
- Master to **-16 LUFS** integrated with a true peak of **-1.5 dBTP**. That is
  the web/podcast target and it is what a landing page and a phone speaker both
  want. If it is going to YouTube, -14 LUFS.
- No music bed is specified. If one is added, duck it 6–8 dB under the voice and
  keep it out of scene 7 entirely — that frame should be the voice and nothing
  else.

## What the script may not say

The film's claims are load-bearing, so the VO stays inside them. Anything added
to this script has to hold against the same list in `README.md`: no claim about
price, return, safety or performance; nothing that implies a test mode exists;
and nothing that presents `$MOON` or `0x8f3c…21ab` as a real launch.
