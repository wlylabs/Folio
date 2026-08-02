#!/usr/bin/env node
/**
 * Writes the intro film's score.
 *
 * The narration is on the glass, where it reads in the muted autoplay a landing
 * page gives a hero video. That leaves the sound a different job: to carry the
 * film for whoever turns it on. So this is written the way a brand intro is —
 * a pulse you can feel, a hook short enough to remember, and a shape that
 * builds, drops out once and resolves — and mixed the way something close to
 * the ear is: soft edges, no hard transients, texture you notice only when it
 * stops.
 *
 *   node scripts/intro-video/score.mjs
 *   node scripts/intro-video/score.mjs --lufs -18 --out /tmp/score.wav
 *
 * There is no library and no sample here — six synthesised voices, a room to
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
/** Integrated loudness. Music carrying a film sits about where speech would. */
const LUFS = Number(opts.lufs ?? -18);
/** The last chord fades over this, ending in silence exactly where the film
    does — the picture decides how long the file is, so anything still ringing
    at the cut would be chopped rather than faded. */
const TAIL = 2.6;

/**
 * 120 bpm, and not for the usual reason: every cut in this film lands on a
 * multiple of half a second, so a half-second beat is the only grid that can
 * be steady and still change chord where the picture changes scene.
 */
const BEAT = 0.5;
const BAR = BEAT * 4;

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

const CUES = [];

/** The hook and its answers: a wooden, close-miked mallet. */
const pluck = (at, note, gain = 0.3, pan = 0) =>
  CUES.push({ voice: "pluck", at, note, gain, pan });

/** A held chord, well under everything else. */
const chord = (at, dur, notes, gain = 0.3) =>
  CUES.push({ voice: "pad", at, dur, notes, gain });

/** The root, low and round. */
const bass = (at, dur, note, gain = 0.34) =>
  CUES.push({ voice: "bass", at, dur, note, gain });

/** The pulse. Felt at the chest rather than heard at the ear. */
const pulse = (at, gain = 0.5) => CUES.push({ voice: "kick", at, gain });

/** The shaker: the ASMR end of the mix, and the only thing above 6 kHz. */
const tick = (at, gain = 0.3, pan = 0) => CUES.push({ voice: "tick", at, gain, pan });

/** Paper: a soft noise swell where the film cuts, and under the last build. */
const paper = (at, dur, gain = 0.3, rise = false) =>
  CUES.push({ voice: "paper", at, dur, gain, rise });

/* --- The pulse and the shaker, laid down first ----------------------------- *
 *
 * Both are written as a grid rather than an arrangement, then thinned where a
 * scene needs the room. The pulse enters where the film's argument does — at
 * the second scene, not the first, so the mark draws itself in quiet — and
 * both leave before the dark frame, which is the only silence in the piece
 * that matters.
 */
for (let t = 8.0; t < 60.5; t += BEAT * 2) {
  const bar = Math.round((t - 8.0) / BAR);
  const down = Math.abs(t / BAR - Math.round(t / BAR)) < 1e-6;
  // Softer between the downbeats: the pulse breathes rather than marches.
  pulse(t, down ? 0.42 : 0.24);
  // A held-back opening: the first four bars come up from nothing.
  if (bar < 4) CUES[CUES.length - 1].gain *= 0.45 + 0.14 * bar;
}
for (let t = 4.0; t < 61.0; t += BEAT) {
  const eighth = Math.round(t / BEAT) % 4;
  tick(t, eighth === 0 ? 0.22 : eighth === 2 ? 0.17 : 0.11, eighth % 2 ? 0.35 : -0.3);
}
for (let t = 70.0; t < 76.0; t += BEAT) {
  const eighth = Math.round(t / BEAT) % 4;
  tick(t, (eighth === 0 ? 0.2 : 0.1) * (1 - (t - 70) / 9), eighth % 2 ? 0.35 : -0.3);
}
for (let t = 70.0; t < 76.5; t += BEAT * 2) pulse(t, t < 74 ? 0.4 : 0.27);

/* --- Harmony --------------------------------------------------------------- *
 *
 * D minor, and it stays there: eight scenes of one argument want a harmony
 * turning over in place rather than a progression going somewhere. B-flat with
 * its third taken out where the usual launch is struck through, F major for
 * the scenes that are Folio's own answer, D under everything that carries
 * weight.
 */
chord(0.0, 7.4, ["D3", "A3", "D4", "F4"], 0.30); //  1 · masthead
bass(0.0, 7.4, "D2", 0.18);

chord(7.5, 4.4, ["Bb3", "F3", "D4"], 0.28); //       2 · the usual launch
bass(7.5, 4.4, "Bb1", 0.22);
chord(12.0, 3.4, ["F3", "Bb3", "F4"], 0.26); //      the third goes with the promise
bass(12.0, 3.5, "Bb1", 0.20);

chord(15.5, 5.0, ["F3", "C4", "A4"], 0.30); //       3 · the listing is the article
bass(15.5, 5.0, "F1", 0.23);
chord(20.5, 4.0, ["C3", "G3", "E4"], 0.28);
bass(20.5, 4.0, "C2", 0.22);
chord(24.5, 5.0, ["D3", "A3", "F4"], 0.30);
bass(24.5, 5.0, "D2", 0.23);

chord(29.5, 5.0, ["Bb3", "F3", "D4"], 0.28); //      4 · how a launch works
bass(29.5, 5.0, "Bb1", 0.22);
chord(34.5, 4.5, ["F3", "C4", "A4"], 0.30);
bass(34.5, 4.5, "F1", 0.23);

chord(39.0, 5.0, ["D3", "A3", "D4"], 0.30); //       5 · the market
bass(39.0, 5.0, "D2", 0.23);
chord(44.0, 4.0, ["Bb3", "F3", "D4"], 0.28);
bass(44.0, 4.0, "Bb1", 0.22);
chord(48.0, 3.5, ["F3", "C4", "A4"], 0.28);
bass(48.0, 3.5, "F1", 0.22);

chord(51.5, 5.0, ["D3", "F3", "A3", "C4"], 0.30); // 6 · what holds it up
bass(51.5, 5.0, "D2", 0.23);
chord(56.5, 4.0, ["Bb3", "F3", "D4"], 0.27);
bass(56.5, 4.0, "Bb1", 0.20);
chord(60.5, 2.4, ["F3", "C4"], 0.20); //             and the room empties out

/* 7 · Real money (1:03) — everything stops. The one inverted frame in the film
   gets the one silence in the score: a single low note, the room it rings in,
   and nothing else until the build starts. */
bass(63.4, 4.2, "D2", 0.30);
pluck(63.45, "D3", 0.34, 0);
pluck(66.45, "A3", 0.26, 0.2);

/* 8 · Outro (1:10) — the chord the piece has been circling, with its ninth in
   it, and the hook one last time an octave up. */
chord(69.9, 7.0, ["D3", "A3", "D4", "F4", "A4"], 0.34);
bass(69.9, 6.0, "D2", 0.24);
chord(74.5, 3.0, ["F3", "C4", "A4", "D5"], 0.26);

/* --- Paper ----------------------------------------------------------------- *
 *
 * A sheet turning, more or less, on every cut — the transition sweetener every
 * intro film has, except that on this one it is also what the product is made
 * of. The last one is a rise rather than a swell: it is the build into the
 * logo, and it is the only loud thing in the piece.
 */
for (const t of [7.5, 15.5, 26.5, 39.0, 51.5]) paper(t - 0.55, 1.1, 0.085);
paper(62.4, 1.3, 0.11);
paper(67.2, 2.85, 0.46, true); //  the build
paper(69.85, 1.4, 0.1);

/* --- The hook -------------------------------------------------------------- *
 *
 * Four notes, D minor pentatonic, stated where the film first says what Folio
 * is and repeated whenever it says it again. It is deliberately short: the
 * point of a hook is that somebody who watched this once can still hum it, and
 * nothing longer survives that.
 */
const HOOK = [
  [0.0, "A4", 0.30],
  [1.0, "D5", 0.32],
  [2.0, "C5", 0.28],
  [2.5, "A4", 0.24],
  [3.0, "F4", 0.26],
];
const hook = (at, gain = 1, octave = 0) => {
  for (const [dt, note, g] of HOOK) {
    const shifted = octave ? note.replace(/\d/, (d) => Number(d) + octave) : note;
    pluck(at + dt, shifted, g * gain, dt % 1 ? 0.18 : -0.15);
  }
};

hook(16.0); //          3 · stated, where the article sets
hook(20.5, 0.8); //     answered a fourth down the phrase
hook(32.5, 0.85); //    4 · under the steps
hook(44.0, 0.8); //     5 · after the quote is taken
hook(52.0, 0.9); //     6 · what holds it up
hook(70.5, 1.0); //     8 · once more, and that is the last of it

/* --- Accents on the picture ------------------------------------------------ *
 *
 * Everything above is the music. These are the places it agrees with a
 * specific frame: each one is snapped to the nearest beat, which is never more
 * than a sixth of a second from the cue it answers and always in time.
 */
pluck(2.0, "D4", 0.26, -0.2); //   1 · F-O-L-I-O begins to land
pluck(3.5, "A4", 0.2, 0.2); //         the tagline
pluck(8.5, "Bb3", 0.26, -0.2); //  2 · the card
pluck(12.0, "Bb2", 0.34, 0); //        the strike-through crosses the promise
pluck(22.0, "C5", 0.26, 0.2); //   3 · the byline earns its Verified chip
pluck(23.0, "F4", 0.24, -0.2); //      the price arrives underneath

pluck(28.0, "D4", 0.28, -0.2); //  4 · the four steps, 2.1s apart on screen
pluck(30.5, "F4", 0.26, 0.2); //       and on the nearest beat here
pluck(32.5, "A4", 0.28, -0.2);
pluck(34.5, "C5", 0.3, 0.2); //        four: one transaction

/* 5 · the curve. Five notes climb while it is drawn, and the sell leg walks
   the same five back down to exactly where the buy began. */
pluck(40.0, "D4", 0.26, -0.25);
pluck(40.5, "E4", 0.24, -0.1);
pluck(41.0, "F4", 0.26, 0.05);
pluck(41.5, "A4", 0.28, 0.2);
pluck(42.0, "C5", 0.3, 0.3);
pluck(43.5, "A4", 0.22, 0); //         the quote is taken
pluck(47.5, "C5", 0.26, 0.3);
pluck(48.0, "A4", 0.24, 0.2);
pluck(48.5, "F4", 0.24, 0.05);
pluck(49.0, "E4", 0.22, -0.1);
pluck(49.5, "D4", 0.26, -0.25);

pluck(53.0, "F4", 0.24, -0.2); //  6 · bylines
pluck(55.0, "A4", 0.22, 0.2); //       articles
pluck(57.0, "C5", 0.22, -0.2); //      trades

pluck(73.5, "D5", 0.28, 0.15); //  8 · "Launch a token"
pluck(75.0, "A4", 0.18, -0.15);

/* -------------------------------------------------------------------------- */
/* The arc                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How loud the piece is, as a function of where it is — one fader over the
 * whole arrangement rather than a level written into every cue.
 *
 * This is the shape an intro has: come up from nothing, grow while the film is
 * making its case, stop dead where it says the money is real, and build back
 * out of that into the logo. The two numbers that matter are the -9 at the
 * drop and the 0 at 70, and the distance between them is the only reason the
 * ending lands.
 */
const ARC = [
  [0.0, -7], [4.0, -5.5], [8.0, -4.5], [15.5, -2.6], [26.5, -1.5], [39.0, -0.7],
  [51.5, 0], [60.4, -0.5],
  [61.6, -9], [63.4, -10], [67.3, -11], //  the film's one silence
  [68.6, -5.5], [70.0, 0], //               the build, and the logo
  [78.0, 0],
];

function arc(t) {
  for (let i = 1; i < ARC.length; i++) {
    if (t <= ARC[i][0]) {
      const [t0, d0] = ARC[i - 1];
      const [t1, d1] = ARC[i];
      const p = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return Math.pow(10, (d0 + (d1 - d0) * p) / 20);
    }
  }
  return Math.pow(10, ARC[ARC.length - 1][1] / 20);
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
  return biquad(x, ((1 + cw) / 2) / a0, (-(1 + cw)) / a0, ((1 + cw) / 2) / a0,
    (-2 * cw) / a0, (1 - alpha) / a0);
}

function lowpass(x, f, q = 0.707) {
  const w = (2 * Math.PI * f) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const cw = Math.cos(w);
  const a0 = 1 + alpha;
  return biquad(x, ((1 - cw) / 2) / a0, (1 - cw) / a0, ((1 - cw) / 2) / a0,
    (-2 * cw) / a0, (1 - alpha) / a0);
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
/* Voices                                                                     */
/* -------------------------------------------------------------------------- */

const panL = (p) => Math.cos(((p + 1) * Math.PI) / 4);
const panR = (p) => Math.sin(((p + 1) * Math.PI) / 4);

/** Adds a mono buffer into the stereo mix at `at`, panned. */
function place(L, R, buf, at, pan) {
  const i0 = Math.round(at * SR);
  const gl = panL(pan), gr = panR(pan);
  for (let i = 0; i < buf.length; i++) {
    const j = i0 + i;
    if (j < 0 || j >= L.length) break;
    L[j] += buf[i] * gl;
    R[j] += buf[i] * gr;
  }
}

/**
 * A mallet on wood. Marimba partials are near 1 : 4 : 10, which is why a bar
 * sounds hollow and a string does not, and the decay is short enough that a
 * run of these reads as rhythm rather than as chord.
 */
function pluckVoice(freq, gain) {
  const base = Math.min(1.5, 0.95 * Math.pow(330 / freq, 0.4));
  const len = Math.round(base * 2.4 * SR);
  const out = new Float32Array(len);
  const attack = Math.round(0.0025 * SR);

  for (const [ratio, amp, decay] of [[1, 1, 1], [3.99, 0.30, 0.42], [10.1, 0.10, 0.22]]) {
    const f = freq * ratio;
    if (f > SR / 2.2) continue;
    const w = (2 * Math.PI * f) / SR;
    const tau = base * decay * SR;
    for (let i = 0; i < len; i++) {
      const env = (i < attack ? i / attack : 1) * Math.exp(-i / tau);
      if (i > attack && env < 1e-5) break;
      out[i] += gain * amp * env * Math.sin(w * i);
    }
  }

  // The mallet head itself. Soft — felt, not plastic.
  for (let i = 0; i < Math.round(0.012 * SR); i++) {
    out[i] += (Math.random() * 2 - 1) * gain * 0.16 * Math.exp(-i / (0.0022 * SR));
  }
  lowpass(out, 5200);
  return out;
}

/**
 * A held chord voice: three copies four cents apart, harmonics rolled off
 * hard, a slow swell in and a slower let-go. Detuning is what keeps it from
 * being an organ; the roll-off is what keeps it under everything else.
 */
function padVoice(freq, gain, dur) {
  const attack = Math.min(1.8, dur * 0.4);
  const release = Math.min(2.6, dur * 0.7);
  const len = Math.round((dur + release) * SR);
  const out = new Float32Array(len);

  for (const cents of [-4, 0, 4]) {
    const f0 = freq * Math.pow(2, cents / 1200);
    for (let n = 1; n <= 5; n++) {
      const f = f0 * n;
      if (f > SR / 2.2) break;
      const amp = (gain / (cents === 0 ? 2.2 : 4.4)) * Math.pow(n, -2.6);
      const w = (2 * Math.PI * f) / SR;
      const phase = (n * 2.399 + cents) % (2 * Math.PI);
      for (let i = 0; i < len; i++) {
        const t = i / SR;
        const env =
          t < attack
            ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack)
            : t < dur
              ? 1
              : Math.max(0, 1 - (t - dur) / release) ** 2;
        if (t > dur && env <= 0) break;
        const drift = 1 + 0.02 * Math.sin(2 * Math.PI * 0.09 * t + n);
        out[i] += amp * env * drift * Math.sin(w * i + phase);
      }
    }
  }
  return out;
}

/** The root: a sine with just enough second harmonic to be audible on a phone. */
function bassVoice(freq, gain, dur) {
  const attack = 0.06, release = 0.5;
  const len = Math.round((dur + release) * SR);
  const out = new Float32Array(len);
  for (const [ratio, amp] of [[1, 1], [2, 0.22], [3, 0.06]]) {
    const w = (2 * Math.PI * freq * ratio) / SR;
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const env =
        t < attack ? t / attack : t < dur ? 1 : Math.max(0, 1 - (t - dur) / release) ** 2;
      if (t > dur && env <= 0) break;
      out[i] += gain * amp * env * Math.sin(w * i);
    }
  }
  return out;
}

/** The pulse: a short sine dropping in pitch, which is all a soft kick is. */
function kickVoice(gain) {
  const len = Math.round(0.42 * SR);
  const out = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 46 + 54 * Math.exp(-t / 0.028);
    phase += (2 * Math.PI * f) / SR;
    const env = Math.exp(-t / 0.115) * (t < 0.002 ? t / 0.002 : 1);
    out[i] = gain * env * Math.sin(phase);
  }
  return out;
}

/** The shaker: twelve milliseconds of noise, and the top of the whole mix. */
function tickVoice(gain) {
  const len = Math.round(0.05 * SR);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (Math.random() * 2 - 1) * gain * Math.exp(-i / (0.006 * SR));
  }
  highpass(out, 4200);
  highpass(out, 4200);
  lowpass(out, 12000);
  return out;
}

/**
 * Paper. A noise swell, band-limited to where a page actually lives, either
 * held flat as a turn or opened upward as a build into the last scene.
 */
function paperVoice(gain, dur, rise) {
  const len = Math.round(dur * SR);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const p = i / len;
    const env = rise
      ? Math.pow(p, 2.2)
      : Math.sin(Math.PI * p) ** 1.6;
    out[i] = (Math.random() * 2 - 1) * gain * env;
  }
  if (rise) {
    // Opening the filter as it swells is the whole gesture: a build is a
    // brightening, not just a crescendo.
    let f = 700;
    let x1 = 0, y1 = 0;
    for (let i = 0; i < len; i++) {
      f = 640 + 3900 * Math.pow(i / len, 1.7);
      const a = Math.exp((-2 * Math.PI * f) / SR);
      const y = (1 - a) * out[i] + a * y1;
      y1 = y;
      x1 = out[i];
      out[i] = y;
    }
    highpass(out, 260);
  } else {
    lowpass(out, 3400);
    highpass(out, 900);
    highpass(out, 900);
  }
  return out;
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
  console.log(
    `· ${CUES.length} cues over ${duration.toFixed(1)}s · ${(60 / BEAT).toFixed(0)} bpm · ${LUFS} LUFS`
  );

  const L = new Float32Array(frames);
  const R = new Float32Array(frames);

  for (const c of CUES) {
    const g = c.gain * arc(c.at);
    switch (c.voice) {
      case "pluck":
        place(L, R, pluckVoice(hz(c.note), g), c.at, c.pan);
        break;
      case "pad":
        c.notes.forEach((n, i) => {
          const spread = c.notes.length > 1 ? (i / (c.notes.length - 1) - 0.5) * 0.55 : 0;
          place(L, R, padVoice(hz(n), g / Math.sqrt(c.notes.length), c.dur), c.at, spread);
        });
        break;
      case "bass":
        place(L, R, bassVoice(hz(c.note), g, c.dur), c.at, 0);
        break;
      case "kick":
        place(L, R, kickVoice(g), c.at, 0);
        break;
      case "tick":
        place(L, R, tickVoice(g), c.at, c.pan);
        break;
      case "paper":
        // The build is the one cue that must not be held down by the arc it is
        // climbing out of, so it takes the level it is going to, not the one
        // it starts at.
        place(L, R, paperVoice(c.rise ? c.gain * arc(c.at + c.dur) : g, c.dur, c.rise), c.at, 0);
        break;
    }
  }

  // Room tone: not audible on its own, and audible by its absence.
  const airL = new Float32Array(frames);
  const airR = new Float32Array(frames);
  let n1 = 0, n2 = 0;
  for (let i = 0; i < frames; i++) {
    n1 += 0.35 * ((Math.random() * 2 - 1) - n1);
    n2 += 0.35 * ((Math.random() * 2 - 1) - n2);
    airL[i] = n1 * 0.010;
    airR[i] = n2 * 0.010;
  }
  highpass(airL, 900);
  highpass(airR, 900);
  for (let i = 0; i < frames; i++) {
    L[i] += airL[i];
    R[i] += airR[i];
  }

  /* The send is filtered before the room, not after it. Sending low
     fundamentals into a two-second decay is what turns a chord bed into a
     drone, and a kick into a smear. */
  const sendL = highpass(Float32Array.from(L), 320);
  const sendR = highpass(Float32Array.from(R), 320);
  const wetL = reverb(sendL, 2.1, 1.0);
  const wetR = reverb(sendR, 2.1, 1.13);
  const WET = 0.28;
  for (let i = 0; i < frames; i++) {
    L[i] = L[i] * (1 - WET * 0.4) + wetL[i] * WET;
    R[i] = R[i] * (1 - WET * 0.4) + wetR[i] * WET;
  }

  /* Master: nothing below the kick is doing any work, and the shelf keeps the
     bass out of the way of everything that carries a tune. */
  for (const ch of [L, R]) {
    highpass(ch, 38);
    lowShelf(ch, 190, -3.5);
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
        "-af", `loudnorm=I=${LUFS}:TP=-2:LRA=11,aresample=${SR}`,
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
    `· wrote    ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB, ${duration.toFixed(1)}s)`
  );
}

main().catch((err) => {
  console.error("\n" + (err?.stack || String(err)));
  process.exit(1);
});
