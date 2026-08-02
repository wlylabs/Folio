#!/usr/bin/env node
/**
 * Writes the intro film's score.
 *
 * The film has no voice on it: the narration is on the glass, where it reads
 * in the muted autoplay that a landing page actually gives it, and the sound
 * is texture rather than information. So this is a bed, not a soundtrack —
 * quiet enough that nobody turns it off, and cut to the picture rather than
 * laid under it. Every cue below answers a beat in `intro.html`: the sheet
 * drawing itself, the strike-through landing, the byline earning its chip, the
 * four steps, the curve, the sell leg walking back down it.
 *
 *   node scripts/intro-video/score.mjs
 *   node scripts/intro-video/score.mjs --lufs -20 --out /tmp/score.wav
 *
 * There is no library and no sample here — two synthesised voices, a room to
 * put them in, and a cue list. Which is the same bargain the film makes with
 * its own pictures: nothing borrowed, nothing that has to be licensed, and
 * every second of it answerable to something in the repository.
 *
 * Needs an ffmpeg, for the loudness pass only.
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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
const OUT = path.resolve(opts.out ?? path.join(HERE, "folio-intro-score.wav"));
const SR = 48000;
/** Music alone under a film, rather than under a voice: quiet, but not shy. */
const LUFS = Number(opts.lufs ?? -20);
/** The last chord is faded out over this, ending in silence exactly where the
    film does — anything still ringing at the cut would be chopped, since the
    picture is what decides how long the file is. */
const TAIL = 2.2;

/* -------------------------------------------------------------------------- */
/* Pitch                                                                      */
/* -------------------------------------------------------------------------- */

const SEMITONE = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

/** "F#3", "Bb2", "A4" → Hz, equal temperament, A4 = 440. */
function hz(note) {
  const m = /^([A-G])([b#]?)(-?\d)$/.exec(note);
  if (!m) throw new Error(`not a note: ${note}`);
  const [, letter, accidental, octave] = m;
  const n =
    SEMITONE[letter] +
    (accidental === "#" ? 1 : accidental === "b" ? -1 : 0) +
    (Number(octave) - 4) * 12;
  return 440 * Math.pow(2, n / 12);
}

/* -------------------------------------------------------------------------- */
/* The cue list                                                               */
/* -------------------------------------------------------------------------- */

/**
 * D minor, and it stays there. The film is eight scenes of one argument, so
 * the score is one harmony bending around a pedal rather than a progression
 * going somewhere: F major for the two scenes that are Folio's own answer,
 * B-flat with its third taken out for the launch that is being struck through,
 * and D for everything that carries weight.
 */
const CUES = [];

/** A struck note. Decays on its own; `hold` only stretches the decay. */
const key = (at, note, gain = 0.3, hold = 1) =>
  CUES.push({ voice: "key", at, note, gain, hold });

/** A sustained chord: `dur` is how long it is held before it is let go. */
const chord = (at, dur, notes, gain = 0.45, pan = 0) =>
  CUES.push({ voice: "pad", at, dur, notes, gain, pan });

/** Weight under everything, felt more than heard. */
const sub = (at, dur, note, gain = 0.4) =>
  CUES.push({ voice: "sub", at, dur, note, gain });

/* 1 · Masthead (0:00) — the mark draws itself out of nothing, so the chord
   arrives from under the floor and the notes are single. */
chord(0.0, 6.2, ["D3", "A3", "D4", "F4"], 0.26);
key(0.35, "D4", 0.40); //  the sheet's outline begins
key(1.55, "A4", 0.30); //  the crease
key(2.25, "F4", 0.36); //  F-O-L-I-O starts landing
key(2.60, "D5", 0.20);
key(3.65, "C5", 0.24); //  the tagline

/* 2 · The usual launch (0:07.5) — down a third, and when the promise is struck
   through the chord loses its own third with it. */
chord(7.35, 4.4, ["Bb3", "F3", "D4"], 0.24);
key(8.45, "Bb3", 0.32); //  the card
key(9.10, "F4", 0.22); //   the rule under it
chord(11.95, 3.4, ["F3", "Bb3", "F4"], 0.21); // hollow: no third
key(12.15, "Bb2", 0.38); // the strike-through crosses the line
key(13.30, "F3", 0.20);

/* 3 · The listing is the article (0:15.5) — F major, the first warmth in the
   film, and the only motif it has. */
chord(15.35, 10.4, ["F3", "C4", "A3", "C5"], 0.27);
key(16.35, "F4", 0.38); //  the headline sets
key(17.55, "A4", 0.28); //  the article body
key(18.60, "C5", 0.24);
key(20.25, "A4", 0.26); //  the motif, once more, quieter
key(21.95, "C5", 0.30); //  the byline earns its Verified chip
key(22.95, "F4", 0.28); //  the price arrives underneath
key(24.60, "D4", 0.20); //  and settles back toward D

/* 4 · How a launch works (0:26.5) — four steps at 2.1s apart, four notes up. */
chord(26.35, 6.6, ["D3", "A3", "F4"], 0.24);
key(28.15, "D4", 0.34); //  step 1
key(30.25, "F4", 0.32); //  step 2
chord(32.25, 6.9, ["F3", "C4", "A4"], 0.22);
key(32.35, "A4", 0.32); //  step 3
key(34.45, "C5", 0.34); //  step 4 — one transaction
key(35.65, "A4", 0.18);
key(36.55, "F4", 0.15);

/* 5 · The market (0:39) — the curve is drawn upward, the quote is taken at the
   top, and the sell leg walks the same five notes back down. That mirror is
   the whole scene's argument, so it is the whole cue's. */
chord(38.85, 12.4, ["D3", "A3", "D4"], 0.23);
key(40.05, "D4", 0.28); //  the curve begins to draw
key(40.60, "E4", 0.26);
key(41.20, "F4", 0.28);
key(41.80, "A4", 0.30);
key(42.35, "C5", 0.32); //  and reaches its top
chord(43.35, 4.6, ["F3", "C4"], 0.17); // the reserve fills under it
key(43.55, "A4", 0.24); //  the quote
key(45.50, "D5", 0.20);
key(47.50, "C5", 0.28); //  the sell leg: back down the same steps
key(48.05, "A4", 0.26);
key(48.60, "F4", 0.26);
key(49.10, "E4", 0.24);
key(49.60, "D4", 0.28); //  to exactly where the buy began
key(50.70, "D3", 0.22);

/* 6 · What holds it up (0:51.5) — a pedal, because the scene is about things
   that do not move. Three notes for three columns, then a long decrescendo so
   the dark frame can land in near-silence. */
sub(51.35, 10.4, "D2", 0.22);
chord(51.35, 9.6, ["D3", "F3", "A3", "C4"], 0.25);
key(52.60, "F4", 0.28); //  bylines
key(54.70, "A4", 0.26); //  articles
key(56.80, "C5", 0.26); //  trades
key(58.90, "A4", 0.17);

/* 7 · Real money (1:03) — the one inverted frame, and the one place the score
   gets out of the way. Two low notes and a lot of room. */
key(63.45, "D2", 0.44, 1.35); //  "Every launch here is real money."
key(66.45, "A2", 0.30, 1.2); //   the hairline draws under it
chord(67.35, 3.8, ["D3", "A3"], 0.15);

/* 8 · Outro (1:10) — the chord that has been implied since the first bar,
   finally with its fifth and its ninth in it, left to ring out past the cut. */
chord(69.85, 7.4, ["D3", "A3", "D4", "F4", "A4"], 0.27);
key(70.30, "D4", 0.36); //  the mark
key(71.15, "F4", 0.30); //  the wordmark
key(72.05, "A4", 0.32);
key(73.30, "D5", 0.28); //  "Launch a token"
key(75.00, "A4", 0.16); //  and the last thing anyone hears

/* -------------------------------------------------------------------------- */
/* Voices                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A struck string, near enough. Six partials, each decaying faster than the
 * one below it, stretched very slightly sharp the way a real string's are —
 * which is most of the difference between this and a sine with an envelope.
 */
function struck(L, R, at, freq, gain, hold, pan) {
  const i0 = Math.round(at * SR);
  const base = Math.min(4.6, 2.9 * Math.pow(220 / freq, 0.35)) * hold;
  const len = Math.round(Math.min(base * 1.9, 8) * SR);
  const attack = Math.round(0.006 * SR);
  const partials = 7;

  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);

  for (let n = 1; n <= partials; n++) {
    // Inharmonicity: the stiffer the string, the sharper the upper partials.
    const f = freq * n * (1 + 0.00045 * n * n);
    if (f > SR / 2.2) break;
    const amp = gain * Math.pow(n, -1.6) * (n === 1 ? 1 : 0.9);
    const tau = base / (1 + 0.75 * (n - 1));
    const w = (2 * Math.PI * f) / SR;
    const phase = (n * 1.37) % (2 * Math.PI);
    for (let i = 0; i < len; i++) {
      const j = i0 + i;
      if (j < 0 || j >= L.length) continue;
      const env = (i < attack ? i / attack : 1) * Math.exp(-i / (tau * SR));
      // Past the attack, a partial that has decayed to nothing stays there.
      if (i > attack && env < 1e-5) break;
      const s = amp * env * Math.sin(w * i + phase);
      L[j] += s * gl;
      R[j] += s * gr;
    }
  }

  // The hammer itself: a click, filtered until it is only an edge. It is the
  // only thing in the score above 2 kHz, and without it the notes arrive with
  // no front on them at all.
  let lp = 0;
  for (let i = 0; i < Math.round(0.02 * SR); i++) {
    const j = i0 + i;
    if (j < 0 || j >= L.length) continue;
    lp += 0.22 * ((Math.random() * 2 - 1) - lp);
    const s = lp * gain * 0.30 * Math.exp(-i / (0.005 * SR));
    L[j] += s * gl;
    R[j] += s * gr;
  }
}

/**
 * A held tone: three copies a few cents apart, six harmonics rolled off hard,
 * a slow swell in and a slower let-go. Detuning is what keeps it from sounding
 * like an organ, and the roll-off is what keeps it under the picture.
 */
function sustained(L, R, at, freq, gain, dur, pan, harmonics = 5, rolloff = 2.6) {
  const attack = Math.min(2.4, dur * 0.45);
  const release = Math.min(3.2, dur * 0.8);
  const total = dur + release;
  const i0 = Math.round(at * SR);
  const len = Math.round(total * SR);

  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);

  // Four cents, not seven: any wider and a low chord beats audibly instead of
  // just breathing.
  for (const cents of [-4, 0, 4]) {
    const f0 = freq * Math.pow(2, cents / 1200);
    for (let n = 1; n <= harmonics; n++) {
      const f = f0 * n;
      if (f > SR / 2.2) break;
      const amp = (gain / (cents === 0 ? 2.2 : 4.4)) * Math.pow(n, -rolloff);
      const w = (2 * Math.PI * f) / SR;
      const phase = (n * 2.399 + cents) % (2 * Math.PI);
      for (let i = 0; i < len; i++) {
        const j = i0 + i;
        if (j < 0 || j >= L.length) continue;
        const t = i / SR;
        const env =
          t < attack
            ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack)
            : t < dur
              ? 1
              : Math.max(0, 1 - (t - dur) / release) ** 2;
        // Only once it is being let go does a zero mean the note is over.
        if (t > dur && env <= 0) break;
        // A breath of movement, well under anything anyone would call vibrato.
        const drift = 1 + 0.02 * Math.sin(2 * Math.PI * 0.09 * t + n);
        const s = amp * env * drift * Math.sin(w * i + phase);
        L[j] += s * gl;
        R[j] += s * gr;
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

/** A biquad, run in place. The coefficients are the usual cookbook ones. */
function biquad(x, b0, b1, b2, a1, a2) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
  return x;
}

function highpass(x, f, q = 0.707) {
  const w = (2 * Math.PI * f) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const cw = Math.cos(w);
  const a0 = 1 + alpha;
  return biquad(
    x,
    ((1 + cw) / 2) / a0,
    (-(1 + cw)) / a0,
    ((1 + cw) / 2) / a0,
    (-2 * cw) / a0,
    (1 - alpha) / a0
  );
}

function lowShelf(x, f, dB, q = 0.707) {
  const A = Math.pow(10, dB / 40);
  const w = (2 * Math.PI * f) / SR;
  const alpha = (Math.sin(w) / 2) * Math.sqrt((A + 1 / A) * (1 / q - 1) + 2);
  const cw = Math.cos(w);
  const s = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 + (A - 1) * cw + s;
  return biquad(
    x,
    (A * (A + 1 - (A - 1) * cw + s)) / a0,
    (2 * A * (A - 1 - (A + 1) * cw)) / a0,
    (A * (A + 1 - (A - 1) * cw - s)) / a0,
    (-2 * (A - 1 + (A + 1) * cw)) / a0,
    (A + 1 + (A - 1) * cw - s) / a0
  );
}

/* -------------------------------------------------------------------------- */
/* The room                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Four combs into two allpasses, per channel, with the right channel's delays
 * stretched slightly so the two are not the same room heard twice. This is the
 * oldest reverb there is and it is the single thing that stops synthesised
 * notes sounding like a MIDI file.
 */
function reverb(ch, rt60, spread) {
  const combs = [29.7, 37.1, 41.1, 43.7].map((ms) => ms * spread);
  const allpass = [5.0, 1.7].map((ms) => ms * spread);
  const out = new Float32Array(ch.length);

  for (const ms of combs) {
    const d = Math.max(1, Math.round((ms / 1000) * SR));
    const g = Math.pow(10, (-3 * d) / (rt60 * SR));
    const buf = new Float32Array(d);
    let p = 0;
    let damp = 0;
    for (let i = 0; i < ch.length; i++) {
      const y = buf[p];
      // One-pole damping in the loop: a room made of paper, not tile.
      damp += 0.42 * (y - damp);
      buf[p] = ch[i] + damp * g;
      p = (p + 1) % d;
      out[i] += y * 0.25;
    }
  }

  for (const ms of allpass) {
    const d = Math.max(1, Math.round((ms / 1000) * SR));
    const g = 0.7;
    const buf = new Float32Array(d);
    let p = 0;
    for (let i = 0; i < out.length; i++) {
      const y = buf[p];
      const x = out[i];
      buf[p] = x + y * g;
      p = (p + 1) % d;
      out[i] = y - x * g;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* WAV                                                                        */
/* -------------------------------------------------------------------------- */

/** 32-bit float, so the loudness pass downstream has everything to work with. */
function writeWav(file, L, R) {
  const frames = L.length;
  const data = Buffer.alloc(frames * 8);
  for (let i = 0; i < frames; i++) {
    data.writeFloatLE(L[i], i * 8);
    data.writeFloatLE(R[i], i * 8 + 4);
  }
  const header = Buffer.alloc(58);
  header.write("RIFF", 0);
  header.writeUInt32LE(50 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(18, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 8, 28);
  header.writeUInt16LE(8, 32);
  header.writeUInt16LE(32, 34);
  header.writeUInt16LE(0, 36);
  header.write("fact", 38);
  header.writeUInt32LE(4, 42);
  header.writeUInt32LE(frames, 46);
  header.write("data", 50);
  header.writeUInt32LE(data.length, 54);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

const require_ = createRequire(import.meta.url);

/** Any ffmpeg: this one only needs the loudness filter. */
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
    const r = spawnSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.includes("loudnorm")) return bin;
  }
  throw new Error(
    "No ffmpeg found. Install one (`apt install ffmpeg`, `npm i -D ffmpeg-static`) or pass --ffmpeg <path>."
  );
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

/** The film's own length, so the score cannot drift from the cut. */
function filmDuration() {
  const page = fs.readFileSync(path.join(HERE, "intro.html"), "utf8");
  const open = page.indexOf("[", page.indexOf("const SCENES = ["));
  const close = page.indexOf("];", open);
  const scenes = JSON.parse(
    page
      .slice(open, close + 1)
      .replace(/(\w+):/g, '"$1":')
      .replace(/,\s*]/g, "]")
  );
  const last = scenes[scenes.length - 1];
  return last.at + last.dur;
}

async function main() {
  const ffmpeg = findFfmpeg();
  const duration = filmDuration();
  const frames = Math.round(duration * SR);

  console.log(`· ffmpeg   ${ffmpeg}`);
  console.log(`· ${CUES.length} cues over ${duration.toFixed(1)}s at ${LUFS} LUFS`);

  const L = new Float32Array(frames);
  const R = new Float32Array(frames);

  for (const c of CUES) {
    if (c.voice === "key") {
      // Struck notes sit a little off centre, alternating, which opens the
      // middle for nothing in particular — the picture is what is in it.
      const pan = ((CUES.indexOf(c) % 2) * 2 - 1) * 0.12;
      struck(L, R, c.at, hz(c.note), c.gain, c.hold, pan);
    } else if (c.voice === "pad") {
      c.notes.forEach((n, i) => {
        const spread = c.notes.length > 1 ? (i / (c.notes.length - 1) - 0.5) * 0.5 : 0;
        sustained(L, R, c.at, hz(n), c.gain / Math.sqrt(c.notes.length), c.dur, c.pan + spread);
      });
    } else {
      sustained(L, R, c.at, hz(c.note), c.gain, c.dur, 0, 2, 3.4);
    }
  }

  // Room tone: not audible on its own, and audible by its absence. Air, not
  // rumble — a low-frequency hiss would only add to what the pads already put
  // down there.
  const airL = new Float32Array(frames);
  const airR = new Float32Array(frames);
  let n1 = 0, n2 = 0;
  for (let i = 0; i < frames; i++) {
    n1 += 0.35 * ((Math.random() * 2 - 1) - n1);
    n2 += 0.35 * ((Math.random() * 2 - 1) - n2);
    airL[i] = n1 * 0.012;
    airR[i] = n2 * 0.012;
  }
  highpass(airL, 900);
  highpass(airR, 900);
  for (let i = 0; i < frames; i++) {
    L[i] += airL[i];
    R[i] += airR[i];
  }

  /* The send is filtered before the room, not after it. Sending the low
     fundamentals into a 2.6-second decay is what turns a chord bed into a
     drone: the tail should be the harmonics, and the notes themselves should
     keep the bottom to themselves. */
  const sendL = highpass(Float32Array.from(L), 320);
  const sendR = highpass(Float32Array.from(R), 320);
  const wetL = reverb(sendL, 2.6, 1.0);
  const wetR = reverb(sendR, 2.6, 1.13);
  const WET = 0.34;
  for (let i = 0; i < frames; i++) {
    L[i] = L[i] * (1 - WET * 0.4) + wetL[i] * WET;
    R[i] = R[i] * (1 - WET * 0.4) + wetR[i] * WET;
  }

  /* Master: nothing below the lowest note in the score is doing any work, and
     everything above it is doing less than it thinks. */
  for (const ch of [L, R]) {
    highpass(ch, 62);
    lowShelf(ch, 210, -4.5);
  }

  // Out with the picture, and all the way out: silent on the last sample.
  const fadeFrom = Math.round((duration - TAIL) * SR);
  for (let i = 0; i < frames; i++) {
    if (i >= fadeFrom) {
      const p = Math.min(1, (i - fadeFrom) / (TAIL * SR));
      const g = Math.cos((p * Math.PI) / 2) ** 2;
      L[i] *= g;
      R[i] *= g;
    }
    // A soft knee rather than a ceiling: nothing here should ever reach it,
    // and if a cue is edited into reaching it, this bends instead of tearing.
    L[i] = Math.tanh(L[i] * 1.15) * 0.82;
    R[i] = Math.tanh(R[i] * 1.15) * 0.82;
  }

  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  console.log(`· peak     ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS before levelling`);

  const raw = path.join(os.tmpdir(), `folio-score-${process.pid}.wav`);
  writeWav(raw, L, R);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn(
      ffmpeg,
      [
        "-y", "-hide_banner", "-loglevel", "error",
        "-i", raw,
        "-af", `loudnorm=I=${LUFS}:TP=-2:LRA=13,aresample=${SR}`,
        "-c:a", "pcm_s24le",
        OUT,
      ],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  fs.rmSync(raw, { force: true });

  console.log(
    `· wrote    ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB, ` +
      `${duration.toFixed(1)}s)`
  );
}

main().catch((err) => {
  console.error("\n" + (err?.stack || String(err)));
  process.exit(1);
});
