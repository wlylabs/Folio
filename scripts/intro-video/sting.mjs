#!/usr/bin/env node
/**
 * Writes the sting under the seven-second announcement cut.
 *
 * A sting is not a score, and this is deliberately not written like one. There
 * is no groove, no hook and nothing to develop: a swell while the mark draws
 * itself, one chord arriving where the wordmark lands, a bell on the line that
 * says the thing, and a long ring-out. Twenty-odd cues, and it ends in silence
 * exactly where the picture does.
 *
 *   node scripts/intro-video/sting.mjs
 *   node scripts/intro-video/render.mjs --cut live --audio folio-live-sting.wav --crf 21
 *
 * It resolves to F major — the relative major of the D minor everything else
 * in the film sits in. An announcement is the one place this brand is allowed
 * to sound pleased with itself, and that is the smallest way to do it without
 * changing key.
 *
 * Everything here is synthesised: no sample, no library, nothing to license.
 * That is also its limit, and it is worth saying plainly — synthesised audio
 * is approximate where the pictures are exact. Seven seconds is short enough
 * that the trade is worth making; seventy-eight was not.
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
const OUT = path.resolve(opts.out ?? path.join(HERE, "folio-live-sting.wav"));
const SR = 48000;
/** Integrated loudness. A sting can sit where the rest of the web sits. */
const LUFS = Number(opts.lufs ?? -18);

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

const pluck = (at, note, gain = 0.3, pan = 0) =>
  CUES.push({ voice: "pluck", at, note, gain, pan });
const chord = (at, dur, notes, gain = 0.3) =>
  CUES.push({ voice: "pad", at, dur, notes, gain });
const bass = (at, dur, note, gain = 0.3) =>
  CUES.push({ voice: "bass", at, dur, note, gain });
const paper = (at, dur, gain = 0.1, rise = false) =>
  CUES.push({ voice: "paper", at, dur, gain, rise });

/* The picture, and what answers it:
 *
 *   0.25–1.85  the sheet draws its own outline
 *   1.50–2.35  the crease
 *   2.15–3.50  F-O-L-I-O lands, one letter at a time
 *   3.10–4.20  the hairline opens under it
 *   3.60–4.60  "Folio is live"
 *   6.15–7.00  the plate leaves upward
 */

// Under the drawing: a low D, and a swell that is more air than note.
bass(0.1, 3.4, "D2", 0.15);
chord(0.1, 3.3, ["D3", "A3", "D4"], 0.14);
paper(0.9, 2.6, 0.05);

// The letters arrive. One mallet note per phrase, not per letter — five would
// be a xylophone solo, and the wordmark is doing the work.
pluck(2.15, "D4", 0.24, -0.16);
pluck(2.7, "A4", 0.19, 0.16);

// The hairline opens, and the harmony turns toward the major it is going to.
paper(2.9, 1.4, 0.12, true);
chord(3.1, 1.3, ["D3", "A3", "F4"], 0.16);

/* "Folio is live." Everything lands together: F major with its ninth, the root
   under it, and one bell. This is the only moment in the piece, and it gets
   three and a half seconds to ring out rather than a hit and a cut. */
bass(3.6, 3.0, "F1", 0.32);
chord(3.6, 3.1, ["F3", "C4", "A4", "G4"], 0.34);
pluck(3.62, "F5", 0.26, 0);
pluck(3.62, "A4", 0.3, -0.1);
pluck(4.35, "C5", 0.2, 0.18);

// And a last one as the plate leaves, so the silence is arrived at rather than
// fallen into.
pluck(5.6, "A4", 0.14, -0.12);

/** The whole thing is 7.0 seconds because the picture is. */
const DURATION = 7.0;
/** The last chord fades over this, ending silent on the final sample. */
const TAIL = 1.5;


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

/** The live cut's length, read out of intro.html rather than written twice. */
function cutDuration() {
  const page = fs.readFileSync(path.join(HERE, "intro.html"), "utf8");
  const open = page.indexOf("[", page.indexOf("const LIVE = ["));
  const close = page.indexOf("];", open);
  const seg = page.slice(open, close + 1);
  const at = Number(/at:\s*([0-9.]+)/.exec(seg)[1]);
  const dur = Number(/dur:\s*([0-9.]+)/.exec(seg)[1]);
  return at + dur;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const ffmpeg = findFfmpeg();

  const picture = cutDuration();
  if (Math.abs(picture - DURATION) > 0.001) {
    throw new Error(`the live cut is ${picture}s in intro.html but ${DURATION}s here`);
  }

  const frames = Math.round(DURATION * SR);
  console.log(`· ffmpeg   ${ffmpeg}`);
  console.log(`· ${CUES.length} cues over ${DURATION.toFixed(1)}s · ${LUFS} LUFS`);

  const L = new Float32Array(frames);
  const R = new Float32Array(frames);

  for (const c of CUES) {
    switch (c.voice) {
      case "pluck":
        place(L, R, pluckVoice(hz(c.note), c.gain), c.at, c.pan);
        break;
      case "pad":
        c.notes.forEach((n, i) => {
          const spread = c.notes.length > 1 ? (i / (c.notes.length - 1) - 0.5) * 0.55 : 0;
          place(L, R, padVoice(hz(n), c.gain / Math.sqrt(c.notes.length), c.dur), c.at, spread);
        });
        break;
      case "bass":
        place(L, R, bassVoice(hz(c.note), c.gain, c.dur), c.at, 0);
        break;
      case "paper":
        place(L, R, paperVoice(c.gain, c.dur, c.rise), c.at, 0);
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
    airL[i] = n1 * 0.009;
    airR[i] = n2 * 0.009;
  }
  highpass(airL, 900);
  highpass(airR, 900);
  for (let i = 0; i < frames; i++) {
    L[i] += airL[i];
    R[i] += airR[i];
  }

  /* The send is filtered before the room: low fundamentals in a long decay are
     what turn a chord into a drone. A sting rings out, so the room is longer
     here than it would be under a film. */
  const sendL = highpass(Float32Array.from(L), 320);
  const sendR = highpass(Float32Array.from(R), 320);
  const wetL = reverb(sendL, 2.8, 1.0);
  const wetR = reverb(sendR, 2.8, 1.13);
  const WET = 0.32;
  for (let i = 0; i < frames; i++) {
    L[i] = L[i] * (1 - WET * 0.4) + wetL[i] * WET;
    R[i] = R[i] * (1 - WET * 0.4) + wetR[i] * WET;
  }

  for (const ch of [L, R]) {
    highpass(ch, 40);
    lowShelf(ch, 200, -3.5);
  }

  // Out with the picture, and all the way out.
  const fadeFrom = Math.round((DURATION - TAIL) * SR);
  for (let i = 0; i < frames; i++) {
    if (i >= fadeFrom) {
      const p = Math.min(1, (i - fadeFrom) / (TAIL * SR));
      const g = Math.cos((p * Math.PI) / 2) ** 2;
      L[i] *= g;
      R[i] *= g;
    }
    L[i] = Math.tanh(L[i] * 1.15) * 0.82;
    R[i] = Math.tanh(R[i] * 1.15) * 0.82;
  }

  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  console.log(`· peak     ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS before levelling`);

  const raw = path.join(os.tmpdir(), `folio-sting-${process.pid}.wav`);
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

  console.log(`· wrote    ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB, ${DURATION}s)`);
}

main().catch((err) => {
  console.error("\n" + (err?.stack || String(err)));
  process.exit(1);
});
