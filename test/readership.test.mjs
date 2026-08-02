/**
 * The readership line.
 *
 * The figure itself is counted in Postgres (`folio_listing_readership` in
 * lib/schema.sql); what is tested here is the sentence it is printed as, which
 * is where a readership counter usually goes wrong. "1 addresses have bought
 * this, 1 of them have never sold" is the sort of line that makes a reader
 * distrust every other number on the page, and the small cases — one buyer,
 * none yet, all of them still in — are the ones a template gets wrong.
 *
 *   npm run test:web
 */

import test from "node:test";
import assert from "node:assert/strict";

const { readershipLine } = await import("../lib/readership.ts");

/** A date the formatter renders the same way in every timezone this runs in. */
const NOON = "2026-07-14T12:00:00.000Z";

test("no buyers says so, rather than printing a zero", () => {
  assert.equal(
    readershipLine({ buyers: 0, neverSold: 0, since: null }),
    "Nobody has bought this yet."
  );
});

test("one buyer is singular throughout", () => {
  assert.equal(
    readershipLine({ buyers: 1, neverSold: 1, since: null }),
    "One address has bought this, and has never sold back to the curve."
  );
});

test("one buyer who sold out reads as a sale, not as a holding", () => {
  assert.equal(
    readershipLine({ buyers: 1, neverSold: 0, since: null }),
    "One address has bought this. Every one of them has sold back to the curve."
  );
});

test("everybody still in is stated as none having sold", () => {
  assert.equal(
    readershipLine({ buyers: 12, neverSold: 12, since: null }),
    "12 addresses have bought this, and none of them has sold back to the curve."
  );
});

test("a partial holding counts the ones that stayed", () => {
  assert.equal(
    readershipLine({ buyers: 40, neverSold: 31, since: null }),
    "40 addresses have bought this, and 31 of them have never sold back to the curve."
  );
});

test("exactly one holder left agrees with its verb", () => {
  assert.equal(
    readershipLine({ buyers: 9, neverSold: 1, since: null }),
    "9 addresses have bought this, and 1 of them has never sold back to the curve."
  );
});

test("a known first buy is dated, an unknown one is left out", () => {
  const dated = readershipLine({ buyers: 3, neverSold: 2, since: NOON });
  assert.match(dated, /bought this since \w+ \d{1,2}, 2026, and/);

  const undated = readershipLine({ buyers: 3, neverSold: 2, since: null });
  assert.ok(!undated.includes("since"));
});

test("thousands are grouped, so a big launch reads as one", () => {
  assert.match(readershipLine({ buyers: 2500, neverSold: 1200, since: null }), /2,500 addresses/);
});
