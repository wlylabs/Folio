/**
 * Additions, on the way in.
 *
 * Two rules decide what an addition can contain, and both of them are also
 * written in `lib/schema.sql` — the composer's copy exists so a reader is told
 * before a signature is asked for, and the database's copy is the one that is
 * actually enforced. These tests cover the client half plus the escaping that
 * turns typed prose into the HTML the article page renders, which is the one
 * place a person's text meets a page that trusts markup.
 *
 *   npm run test:web
 */

import test from "node:test";
import assert from "node:assert/strict";

const { paragraphsToHtml } = await import("../lib/sanitize.ts");
const { addendumProblem, ADDENDUM_MAX_LENGTH } = await import("../lib/addenda.ts");

test("a blank line starts a new paragraph, a single one breaks a line", () => {
  assert.equal(
    paragraphsToHtml("First thought.\n\nSecond thought.\nSame paragraph."),
    "<p>First thought.</p><p>Second thought.<br />Same paragraph.</p>"
  );
});

test("surrounding blank lines do not become empty paragraphs", () => {
  assert.equal(paragraphsToHtml("\n\n  Only this.  \n\n\n"), "<p>Only this.</p>");
});

test("nothing in, nothing out", () => {
  assert.equal(paragraphsToHtml(""), "");
  assert.equal(paragraphsToHtml(null), "");
  assert.equal(paragraphsToHtml("   \n\n  "), "");
});

test("angle brackets are escaped rather than dropped", () => {
  // The sanitiser's answer for an unknown tag is to discard it, which would
  // silently eat the rest of the sentence. Typed text is not markup.
  assert.equal(
    paragraphsToHtml("I was wrong: a < b, not a > b."),
    "<p>I was wrong: a &lt; b, not a &gt; b.</p>"
  );
});

test("a script tag survives only as visible text", () => {
  const html = paragraphsToHtml('<script>alert("x")</script>');

  assert.ok(!html.includes("<script"));
  assert.equal(
    html,
    "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>"
  );
});

test("an ampersand is escaped once, not twice", () => {
  assert.equal(paragraphsToHtml("Salt & Pepper"), "<p>Salt &amp; Pepper</p>");
  assert.equal(paragraphsToHtml("&amp;"), "<p>&amp;amp;</p>");
});

test("an empty addition is refused before a wallet is disturbed", () => {
  assert.match(addendumProblem(""), /needs something in it/);
  assert.match(addendumProblem("   \n  "), /needs something in it/);
});

test("the length ceiling is measured on the trimmed text", () => {
  const atLimit = "x".repeat(ADDENDUM_MAX_LENGTH);

  assert.equal(addendumProblem(atLimit), null);
  assert.equal(addendumProblem(`\n  ${atLimit}  \n`), null);
  assert.match(addendumProblem(`${atLimit}x`), /at most/);
});

test("ordinary prose has no problem", () => {
  assert.equal(
    addendumProblem("Retracting the third paragraph — the supplier confirmed it yesterday."),
    null
  );
});
