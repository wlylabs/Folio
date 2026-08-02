/**
 * Which blocks the trade recorder reads — the one mistake here that is silent
 * and permanent.
 *
 * Everything else in `lib/tradeRecorder.ts` retries. A chunk that throws leaves
 * the cursor where it was; a row that conflicts is ignored because it is the
 * same row; a cursor that fails to save costs a re-read the primary key makes
 * harmless. But a gap between two chunks is a range the cursor has already
 * moved past, so the trades inside it are never looked for again — a hole in a
 * launch's price history that nothing will notice and nothing will fill.
 *
 * So `planScan` is a pure function and these are its cases. The invariant every
 * one of them is really testing: the chunks are contiguous, they start where
 * the last run stopped, and `through` is the end of the last chunk actually
 * planned rather than the end of the range that was wanted.
 *
 *   npm run test:web
 */

import test from "node:test";
import assert from "node:assert/strict";

const { planScan } = await import("../lib/tradeRecorder.ts");

/** Small numbers, so a plan can be read at a glance. */
const opts = { chunk: 100, maxChunks: 3, margin: 10n };

/** Every block the plan covers, in order, as one flat list. */
function covered(plan) {
  const blocks = [];
  for (const { from, to } of plan.chunks) {
    for (let b = from; b <= to; b++) blocks.push(b);
  }
  return blocks;
}

test("a first run starts at the launch, not at the head", () => {
  const plan = planScan(500n, null, 300n, opts);

  assert.equal(plan.chunks[0].from, 300n);
  assert.equal(plan.chunks[0].to, 399n);
});

test("a later run starts at the block after the last one recorded", () => {
  const plan = planScan(500n, 420n, 300n, opts);

  assert.equal(plan.chunks[0].from, 421n);
  // No re-reading of 420 and, more to the point, no skipping of 421.
  assert.equal(covered(plan)[0], 421n);
});

test("chunks are contiguous — no gap, no overlap", () => {
  const plan = planScan(100_000n, null, 0n, { ...opts, maxChunks: 50 });

  for (let i = 1; i < plan.chunks.length; i++) {
    assert.equal(
      plan.chunks[i].from,
      plan.chunks[i - 1].to + 1n,
      `chunk ${i} does not start where chunk ${i - 1} ended`
    );
  }
});

test("a chunk is exactly the configured width, and the last one is short", () => {
  const plan = planScan(350n, null, 0n, opts);

  assert.deepEqual(plan.chunks, [
    { from: 0n, to: 99n },
    { from: 100n, to: 199n },
    { from: 200n, to: 299n },
  ]);
  // Three is the budget, and the range wanted 340 blocks — so there is more.
  assert.equal(plan.more, true);
  assert.equal(plan.through, 299n);
});

test("the run stops short of the head by the reorg margin", () => {
  const plan = planScan(350n, 200n, 0n, { ...opts, maxChunks: 50 });

  // 350 - 10 = 340, and the last block read is that one and not the head.
  assert.equal(plan.through, 340n);
  assert.equal(plan.chunks.at(-1).to, 340n);
  assert.equal(plan.more, false);
});

test("through is the end of the last chunk planned, never the end wanted", () => {
  // The distinction only shows up when the budget runs out, and getting it
  // wrong is the gap this whole file is about: a cursor at `safeHead` after
  // reading three chunks skips everything between.
  const short = planScan(10_000n, null, 0n, opts);
  assert.equal(short.through, 299n);
  assert.notEqual(short.through, 9_990n);

  const complete = planScan(250n, null, 0n, opts);
  assert.equal(complete.through, 240n);
});

test("a run with nothing new plans nothing and moves nothing", () => {
  // The cursor is already past `head - margin`. Moving it to `safeHead` here
  // would skip the margin's blocks the moment they aged in.
  const plan = planScan(300n, 295n, 0n, opts);

  assert.deepEqual(plan.chunks, []);
  assert.equal(plan.through, 295n);
  assert.equal(plan.more, false);
});

test("resuming twice covers each block exactly once", () => {
  // The property that matters end to end: run, record, run again, and the two
  // runs between them have read every block in the range and read none twice.
  const head = 1_000n;
  const seen = [];

  let cursor = null;
  for (let run = 0; run < 20; run++) {
    const plan = planScan(head, cursor, 0n, opts);
    if (plan.chunks.length === 0) break;
    seen.push(...covered(plan));
    cursor = plan.through;
  }

  const expected = [];
  for (let b = 0n; b <= head - opts.margin; b++) expected.push(b);

  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen.map(String)).size, seen.length, "a block was read twice");
});

test("a chain younger than the margin plans nothing rather than underflowing", () => {
  // bigint subtraction below zero throws rather than wrapping, so this is a
  // crash and not a wrong number — but only ever on a fresh local devnet.
  const plan = planScan(5n, null, 0n, opts);

  assert.deepEqual(plan.chunks, [{ from: 0n, to: 0n }]);
  assert.equal(plan.through, 0n);
});

test("a launch newer than the safe head waits rather than reading backwards", () => {
  const plan = planScan(300n, null, 295n, opts);

  assert.deepEqual(plan.chunks, []);
  // Nothing recorded yet, so the cursor must not claim block 294 was read.
  assert.equal(plan.through, 294n);
});

test("the real defaults hold the same invariants", () => {
  // Without `opts`, so the shipped chunk width, budget and margin are the ones
  // under test rather than the readable stand-ins above.
  const plan = planScan(10_000_000n, 5_000_000n, 1n);

  assert.ok(plan.chunks.length > 0);
  assert.equal(plan.chunks[0].from, 5_000_001n);
  for (let i = 1; i < plan.chunks.length; i++) {
    assert.equal(plan.chunks[i].from, plan.chunks[i - 1].to + 1n);
  }
  assert.equal(plan.through, plan.chunks.at(-1).to);
  assert.equal(plan.more, true);
});
