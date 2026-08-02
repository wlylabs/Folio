#!/usr/bin/env node
/**
 * Speaks the intro film's narration and lays it on the film's own clock.
 *
 * The script is not written twice. `CAPTIONS` in intro.html is the narration —
 * it is what the silent cut prints on the glass — so this reads that array out
 * of the page rather than keeping a second copy that could drift from it. Each
 * line is synthesised, then placed at the caption's in-point, so the voice and
 * the pictures agree by construction: change a caption's timing and the voice
 * moves with it.
 *
 *   node scripts/intro-video/narrate.mjs
 *   node scripts/intro-video/narrate.mjs --rate 1.2 --out /tmp/vo.wav
 *
 * Then render the voiced cut — captions off, because read-and-heard at once is
 * worse than either:
 *
 *   node scripts/intro-video/render.mjs --no-captions \
 *        --audio scripts/intro-video/folio-intro-vo.wav \
 *        --out scripts/intro-video/folio-intro-vo.mp4
 *
 * Requirements: Piper (`pip install piper-tts`) and an ffmpeg. Neither is a
 * dependency of the site, so neither is in package.json — they are looked up
 * when this runs and named in the error if they are missing. A voice model is
 * fetched once into .cache/, the same way render.mjs fetches the webfonts.
 *
 * A recorded human take needs none of this: any WAV can go straight to
 * render.mjs --audio. This exists so that the film has a voice at all.
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, ".cache");
const VOICES = path.join(CACHE, "voices");

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
const OUT = path.resolve(opts.out ?? path.join(HERE, "folio-intro-vo.wav"));
const VOICE = String(opts.voice ?? "en_US-ryan-high");
/** Piper's phoneme length. Above 1 is slower; this is a film, not a bulletin. */
const RATE = Number(opts.rate ?? 1.1);
/** How long after a caption arrives the voice starts, in seconds. */
const LEAD = Number(opts.lead ?? 0);
/** Clearance a line keeps before its caption's out-point. */
const TAIL = 0.25;
/** Floor for the automatic tightening below: quicker than this sounds hurried. */
const RATE_FLOOR = 0.88;
/** Loudness target. -16 LUFS is the usual answer for speech on the web. */
const LUFS = Number(opts.lufs ?? -16);

/* -------------------------------------------------------------------------- */
/* The script, read out of the film                                           */
/* -------------------------------------------------------------------------- */

/**
 * Lifts a top-level array literal out of intro.html by name and evaluates it.
 *
 * The alternative is driving a browser to ask the page for `CAPTIONS`, which
 * would make Playwright a requirement of writing audio. The array is a plain
 * literal of plain values by convention — keep it one, and this keeps working.
 */
function literalFromPage(source, name) {
  const decl = source.indexOf(`const ${name} = [`);
  if (decl < 0) throw new Error(`intro.html has no \`const ${name} = [\``);
  const open = source.indexOf("[", decl);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      return vm.runInNewContext(source.slice(open, i + 1));
    }
  }
  throw new Error(`\`${name}\` in intro.html is not a closed array literal`);
}

/**
 * What a voice says where the page prints something else.
 *
 * Only for words the synthesiser gets wrong, and only as far as the sound: the
 * sentence itself is the caption's, unedited. `mainnet` is one word to a reader
 * and two to a speaker — left alone it comes out "MAIN-it".
 */
const SAY = [[/\bmainnet\b/gi, "main net"]];

/** Typography a page wants and a phonemiser does not. */
function speakable(text) {
  let s = text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, ".")
    // An em dash is a breath, and the phonemiser hears it as one — as long as
    // it is spaced, so this normalises the spacing rather than removing it.
    .replace(/\s*—\s*/g, " — ")
    .replace(/–/g, ",")
    // A hyphen inside a compound glues both halves into one word: "row-level"
    // becomes "role-evel". The page keeps the hyphen; the voice does not.
    .replace(/(\w)-(\w)/g, "$1 $2");
  for (const [re, to] of SAY) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

const require_ = createRequire(import.meta.url);

function run(bin, argv, input) {
  return spawnSync(bin, argv, { encoding: "buffer", input, maxBuffer: 1 << 30 });
}

/** Piper, as a command or as a module of whichever Python has it. */
function findPiper() {
  const tries = [];
  if (opts.piper) tries.push([String(opts.piper), []]);
  tries.push(["piper", []], ["python3", ["-m", "piper"]], ["python", ["-m", "piper"]]);
  for (const [bin, pre] of tries) {
    const r = run(bin, [...pre, "--help"]);
    if (r.status === 0 && String(r.stdout).includes("--length-scale")) return { bin, pre };
  }
  throw new Error(
    "Piper not found. `pip install piper-tts`, or pass --piper <path>.\n" +
      "A recorded take needs no synthesiser: render.mjs --audio <file.wav>."
  );
}

/** Any ffmpeg. This one only moves PCM around, so no encoder is required. */
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
    const r = run(bin, ["-hide_banner", "-filters"]);
    if (r.status === 0 && String(r.stdout).includes("loudnorm")) return bin;
  }
  throw new Error(
    "No ffmpeg found. Install one (`apt install ffmpeg`, `npm i -D ffmpeg-static`) or pass --ffmpeg <path>."
  );
}

/**
 * A voice model, fetched once. 120 MB of ONNX belongs in the tree even less
 * than the webfonts do, and Piper's voices are all one URL apart, so `--voice`
 * takes either a name from the Piper catalogue or a path to a local .onnx.
 */
async function voiceModel(name) {
  if (name.endsWith(".onnx")) return path.resolve(name);

  const m = name.match(/^([a-z]{2})_([A-Z]{2})-(.+)-(x_low|low|medium|high)$/);
  if (!m) {
    throw new Error(
      `--voice wants a Piper voice name like en_US-ryan-high, or a path to an .onnx (got "${name}")`
    );
  }
  const [, lang, region, speaker, quality] = m;
  const local = path.join(VOICES, `${name}.onnx`);
  if (fs.existsSync(local) && fs.existsSync(local + ".json")) return local;

  const base =
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/" +
    `${lang}/${lang}_${region}/${speaker}/${quality}/${name}.onnx`;
  console.log(`· fetching voice ${name} (first run only)…`);
  fs.mkdirSync(VOICES, { recursive: true });
  for (const [url, dest] of [
    [base, local],
    [base + ".json", local + ".json"],
  ]) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  return local;
}

/* -------------------------------------------------------------------------- */
/* Audio                                                                      */
/* -------------------------------------------------------------------------- */

/** Seconds of PCM in a RIFF file, off the header. Cheaper than asking ffprobe. */
function wavSeconds(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error(`${file} is not a RIFF file`);
  let rate = 0, blockAlign = 0;
  for (let p = 12; p + 8 <= buf.length; ) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") {
      rate = buf.readUInt32LE(p + 12);
      blockAlign = buf.readUInt16LE(p + 20);
    } else if (id === "data") {
      return size / (rate * blockAlign);
    }
    p += 8 + size + (size % 2);
  }
  throw new Error(`${file} has no data chunk`);
}

function speak(piper, model, text, lengthScale, out) {
  const r = run(piper.bin, [
    ...piper.pre,
    "-m", model,
    "-f", out,
    "--length-scale", lengthScale.toFixed(4),
    // Piper's own default is 0.2s, which reads as a stumble between the two
    // sentences of a line that has two.
    "--sentence-silence", "0.35",
  ], Buffer.from(text + "\n"));
  if (r.status !== 0 || !fs.existsSync(out)) {
    throw new Error(`piper failed on "${text}"\n${String(r.stderr).trim()}`);
  }
  return wavSeconds(out);
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const page = fs.readFileSync(path.join(HERE, "intro.html"), "utf8");
  const scenes = literalFromPage(page, "SCENES");
  const captions = literalFromPage(page, "CAPTIONS");
  const duration = scenes[scenes.length - 1].at + scenes[scenes.length - 1].dur;

  const piper = findPiper();
  const ffmpeg = findFfmpeg();
  const model = await voiceModel(VOICE);

  console.log(`· piper    ${[piper.bin, ...piper.pre].join(" ")}`);
  console.log(`· voice    ${path.basename(model, ".onnx")}`);
  console.log(`· ffmpeg   ${ffmpeg}`);
  console.log(`· ${captions.length} lines over ${duration.toFixed(1)}s at rate ${RATE}`);

  fs.mkdirSync(CACHE, { recursive: true });
  const work = fs.mkdtempSync(path.join(CACHE, "vo-"));
  const lines = [];
  try {
    for (const [i, cap] of captions.entries()) {
      const at = cap.at + LEAD;
      const room = cap.out - at - TAIL;
      const text = speakable(cap.text);
      const wav = path.join(work, `line-${i}.wav`);

      let rate = RATE;
      let secs = speak(piper, model, text, rate, wav);
      // A caption holds long enough to be read, which is longer than the line
      // takes to say — so this only ever tightens, and only when a line would
      // otherwise still be talking after its picture has gone.
      if (secs > room) {
        rate = Math.max(RATE_FLOOR, rate * (room / secs));
        secs = speak(piper, model, text, rate, wav);
      }
      lines.push({ wav, at, secs, rate, out: cap.out, text });

      const over = secs > room ? " OVER" : "";
      const head = text.length > 46 ? text.slice(0, 45) + "…" : text;
      console.log(
        `  ${String(i + 1).padStart(2)}  ${at.toFixed(1).padStart(5)}s ` +
          `+${secs.toFixed(1)}s  in ${(cap.out - at).toFixed(1)}s ` +
          `· rate ${rate.toFixed(2)}${over}  ${head}`
      );
    }

    for (const [i, l] of lines.entries()) {
      const next = lines[i + 1];
      if (next && l.at + l.secs > next.at) {
        console.warn(`! line ${i + 1} runs into line ${i + 2} by ${(l.at + l.secs - next.at).toFixed(2)}s`);
      }
    }

    /* One pass: a silent bed the length of the film, every line delayed onto
       it, then levelled as a whole so the quiet lines stay quieter than the
       loud ones and the track as a whole lands where a browser wants it. */
    const inputs = ["-f", "lavfi", "-t", duration.toFixed(3), "-i", "anullsrc=r=48000:cl=mono"];
    for (const l of lines) inputs.push("-i", l.wav);

    const chain = lines
      .map((l, i) => `[${i + 1}:a]aresample=48000,adelay=delays=${Math.round(l.at * 1000)}:all=1[v${i}]`)
      .join(";");
    const mix =
      `[0:a]${lines.map((_, i) => `[v${i}]`).join("")}` +
      `amix=inputs=${lines.length + 1}:normalize=0:dropout_transition=0[sum];` +
      `[sum]highpass=f=70,loudnorm=I=${LUFS}:TP=-1.5:LRA=11,` +
      `atrim=0:${duration.toFixed(3)},asetpts=N/SR/TB,` +
      `afade=t=in:st=0:d=0.25,afade=t=out:st=${(duration - 0.8).toFixed(3)}:d=0.8[out]`;

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await new Promise((resolve, reject) => {
      const p = spawn(
        ffmpeg,
        [
          "-y", "-hide_banner", "-loglevel", "error",
          ...inputs,
          "-filter_complex", `${chain};${mix}`,
          "-map", "[out]",
          "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1",
          OUT,
        ],
        { stdio: ["ignore", "inherit", "inherit"] }
      );
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  const spoken = lines.reduce((a, l) => a + l.secs, 0);
  console.log(
    `· wrote    ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB, ` +
      `${spoken.toFixed(1)}s of speech in ${duration.toFixed(1)}s)`
  );
}

main().catch((err) => {
  console.error("\n" + (err?.stack || String(err)));
  process.exit(1);
});
