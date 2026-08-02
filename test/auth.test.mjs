/**
 * The wallet sign-in, tested where it can be tested without a browser.
 *
 * Two modules carry the whole of Folio's answer to "is this byline real":
 * `lib/siwe.ts` decides what a signed message said, and `lib/authToken.ts`
 * decides whether a nonce was ours and what a session may claim. Both are pure
 * functions over strings, both are the sort of code where a lenient branch is
 * invisible until somebody uses it, and neither needs a wallet to exercise.
 *
 * What is deliberately not here: the signature check itself. Recovering an
 * address from a signature is viem's, tested by viem, and standing an ECDSA
 * fixture up here would test that this file can copy a hex string. The
 * decisions *around* the recovery — the ones this project wrote — are what the
 * cases below cover.
 *
 *   node --experimental-strip-types --test test/auth.test.mjs
 *
 * or `npm run test:web`, which is what CI runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

// Set before the import: lib/authToken.ts reads the secret at module scope,
// which is what makes `siweConfigured` a constant rather than a call.
process.env.SUPABASE_JWT_SECRET = "test-secret-that-is-long-enough-to-count-32";

const { buildSiweMessage, parseSiweMessage, isoAt, SIWE_STATEMENT } = await import(
  "../lib/siwe.ts"
);
const { mintNonce, claimNonce, mintSession, siweConfigured, NONCE_TTL_MS } = await import(
  "../lib/authToken.ts"
);

const FIELDS = {
  domain: "folio.example",
  address: "0x1234567890AbcdEF1234567890aBcdef12345678",
  statement: SIWE_STATEMENT,
  uri: "https://folio.example/create",
  chainId: 4663,
  nonce: "0123456789abcdef",
  issuedAt: "2026-01-01T00:00:00.000Z",
  expirationTime: "2026-01-01T00:10:00.000Z",
};

test("a built message round-trips through the parser unchanged", () => {
  const parsed = parseSiweMessage(buildSiweMessage(FIELDS));
  assert.deepEqual(parsed, FIELDS);
});

test("the message is EIP-4361's layout, which is what wallets render", () => {
  const lines = buildSiweMessage(FIELDS).split("\n");

  assert.equal(lines[0], "folio.example wants you to sign in with your Ethereum account:");
  assert.equal(lines[1], FIELDS.address);
  assert.equal(lines[2], "");
  assert.equal(lines[3], SIWE_STATEMENT);
  assert.equal(lines[4], "");
  assert.equal(lines[5], "URI: https://folio.example/create");
  assert.equal(lines[6], "Version: 1");
  assert.equal(lines[7], "Chain ID: 4663");
});

test("a message that arrived with CRLF endings still parses", () => {
  const parsed = parseSiweMessage(buildSiweMessage(FIELDS).replace(/\n/g, "\r\n"));
  assert.deepEqual(parsed, FIELDS);
});

test("the parser refuses anything that is not exactly this grammar", () => {
  const bad = {
    "an extra field appended": buildSiweMessage(FIELDS) + "\nResources: https://evil.example",
    "a missing field": buildSiweMessage(FIELDS).replace("\nVersion: 1", ""),
    "a duplicated field": buildSiweMessage(FIELDS).replace(
      "Version: 1",
      "Version: 1\nChain ID: 1"
    ),
    "another version of the spec": buildSiweMessage({ ...FIELDS, chainId: 1 }).replace(
      "Version: 1",
      "Version: 2"
    ),
    "a non-alphanumeric nonce": buildSiweMessage({ ...FIELDS, nonce: "../../etc" }),
    "a short nonce": buildSiweMessage({ ...FIELDS, nonce: "abc" }),
    "an address that is not one": buildSiweMessage({ ...FIELDS, address: "0xnothex" }),
    "a timestamp with no timezone": buildSiweMessage({
      ...FIELDS,
      issuedAt: "2026-01-01T00:00:00",
    }),
    "a timestamp that is not a date": buildSiweMessage({ ...FIELDS, issuedAt: "tomorrow" }),
    "an empty domain": buildSiweMessage({ ...FIELDS, domain: "" }),
    "no statement": buildSiweMessage({ ...FIELDS, statement: "" }),
    "an empty string": "",
    "a header from somewhere else": buildSiweMessage(FIELDS).replace(
      "wants you to sign in with your Ethereum account:",
      "wants your seed phrase:"
    ),
  };

  for (const [what, message] of Object.entries(bad)) {
    assert.equal(parseSiweMessage(message), null, `should have refused: ${what}`);
  }
});

test("a chain id is read as a number, not as whatever the string looked like", () => {
  const parsed = parseSiweMessage(buildSiweMessage({ ...FIELDS, chainId: 8453 }));
  assert.equal(parsed.chainId, 8453);
  assert.equal(typeof parsed.chainId, "number");

  // Not "0x2105", not " 8453", not "8453abc" — each of those is a different
  // claim about which chain the wallet was on.
  for (const forged of ["0x2105", " 8453", "8453abc", "-1", "1e4"]) {
    const message = buildSiweMessage(FIELDS).replace("Chain ID: 4663", `Chain ID: ${forged}`);
    assert.equal(parseSiweMessage(message), null, `should have refused chain id ${forged}`);
  }
});

test("a nonce this server minted is accepted exactly once", () => {
  const nonce = mintNonce();

  assert.match(nonce, /^[0-9a-f]{60}$/);
  assert.deepEqual(claimNonce(nonce), { ok: true });

  const second = claimNonce(nonce);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already used/);
});

test("a nonce nobody minted is refused", () => {
  for (const forged of [
    "",
    "not-a-nonce",
    "f".repeat(60),
    mintNonce().slice(0, 59),
    mintNonce().slice(0, 59) + "0",
    mintNonce().toUpperCase(),
  ]) {
    assert.equal(claimNonce(forged).ok, false, `should have refused: ${forged}`);
  }
});

test("a nonce stops working when its own expiry passes", () => {
  const now = Date.now();
  const nonce = mintNonce(now);

  const late = claimNonce(nonce, now + NONCE_TTL_MS + 1_000);
  assert.equal(late.ok, false);
  assert.match(late.reason, /expired/);
});

test("a session is an HS256 JWT that Supabase will accept", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const { token, expiresAt } = mintSession("0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa", now);

  const [header, payload, signature] = token.split(".");
  assert.equal(token.split(".").length, 3);

  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "HS256",
    typ: "JWT",
  });

  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(claims.role, "authenticated");
  assert.equal(claims.aud, "authenticated");
  // Lowercased, because that is how every address in this project is stored and
  // how the insert policy compares it.
  assert.equal(claims.wallet, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(claims.iat, now / 1000);
  assert.equal(claims.exp * 1000, expiresAt);
  assert.ok(claims.exp > claims.iat, "a session must expire after it is issued");
  assert.match(claims.sub, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

  // The signature is over the first two segments with the project secret, which
  // is the only reason PostgREST will believe any of the above.
  const expected = createHmac("sha256", process.env.SUPABASE_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  assert.equal(signature, expected);
});

test("the same wallet is the same subject every time, and two wallets are not", () => {
  const a = subjectOf(mintSession("0x1111111111111111111111111111111111111111").token);
  const again = subjectOf(mintSession("0x1111111111111111111111111111111111111111").token);
  const b = subjectOf(mintSession("0x2222222222222222222222222222222222222222").token);

  assert.equal(a, again);
  assert.notEqual(a, b);
});

test("a checksummed address and its lowercase form are one identity", () => {
  const upper = mintSession("0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa").token;
  const lower = mintSession("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").token;

  assert.equal(subjectOf(upper), subjectOf(lower));
});

test("verification is on when a real secret is set", () => {
  assert.equal(siweConfigured, true);
});

test("issuedAt is written the one way the parser will read back", () => {
  const stamp = isoAt(Date.parse("2026-06-05T04:03:02.001Z"));
  assert.equal(stamp, "2026-06-05T04:03:02.001Z");
  assert.deepEqual(parseSiweMessage(buildSiweMessage({ ...FIELDS, issuedAt: stamp })).issuedAt, stamp);
});

function subjectOf(token) {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub;
}
