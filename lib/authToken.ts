import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The server half of Sign-In With Ethereum: nonces out, Supabase JWTs back.
 *
 * Two secrets-handling jobs live here and nowhere else.
 *
 *  1. **Issuing and checking nonces.** A nonce is what stops a signature being
 *     replayed — the reader signs something this server chose, so a signature
 *     captured from somewhere else is a signature over the wrong text.
 *  2. **Minting the session.** Once a signature checks out, the caller gets a
 *     JWT signed with the Supabase project's own secret, carrying the address
 *     as a claim. PostgREST validates that signature, and the insert policy in
 *     `lib/schema.sql` reads the claim, so the address is enforced by the
 *     database rather than by whichever component remembered to check.
 *
 * ## Server only
 *
 * `SUPABASE_JWT_SECRET` is the key that mints identities for the whole project.
 * Nothing in here may be imported from a client component: this module imports
 * `node:crypto`, which is a build error in the browser bundle rather than a
 * silent leak, and that is deliberately the loudest available guard.
 *
 * ## Optional, and off by default
 *
 * With no `SUPABASE_JWT_SECRET` set, {@link siweConfigured} is false, the two
 * auth routes answer 501, and the create page publishes with the anon key
 * exactly as it did before — an unverified byline, honestly labelled. A deploy
 * turns verification on by setting the secret and running the current
 * `lib/schema.sql`; it does not need a code change and it does not break the
 * listings written before it.
 */

/** The Supabase project's JWT secret. Absent means SIWE is switched off. */
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

/**
 * True when this deployment can verify a wallet.
 *
 * A short secret is treated as no secret. Supabase's own is 40-plus characters
 * of base64; anything much shorter is a placeholder somebody pasted, and
 * signing real sessions with it would be worse than not offering verification
 * at all — the whole value of the claim is that it cannot be forged.
 */
export const siweConfigured = Boolean(JWT_SECRET && JWT_SECRET.length >= 32);

/**
 * How long a freshly issued nonce may be signed for.
 *
 * Long enough to read the message and find the wallet's confirm button on a
 * phone, short enough that a captured message is worthless by the time anyone
 * could use it. The signature itself carries an expiry too — this is the
 * server's own clock on the same question, and the shorter of the two wins.
 */
export const NONCE_TTL_MS = 10 * 60_000;

/**
 * How long a minted session lasts.
 *
 * A launch is a form, an upload, a transaction and an insert, and the reader
 * may sit on the confirmation for a while — so this is generous. It is also
 * bounded, and short of the point where a token left in a shared browser is
 * still worth stealing; `lib/walletAuth.ts` keeps it in `sessionStorage` for
 * the same reason.
 */
export const SESSION_TTL_MS = 60 * 60_000;

/** Nonce layout: 16 hex of randomness, 12 hex of expiry, 32 hex of tag. */
const NONCE_RANDOM_HEX = 16;
const NONCE_EXPIRY_HEX = 12;
const NONCE_TAG_HEX = 32;
const NONCE_LENGTH = NONCE_RANDOM_HEX + NONCE_EXPIRY_HEX + NONCE_TAG_HEX;

/**
 * Nonces already spent, so one cannot be used twice.
 *
 * The nonce is stateless — its expiry and its tag travel inside it — which is
 * what lets a serverless deployment issue one on one instance and verify it on
 * another without a shared store. The cost of that is that statelessness alone
 * cannot say "already used", so this set does, in memory, per instance.
 *
 * That makes single-use best-effort rather than absolute, and it is worth being
 * precise about what survives if it fails: a replayed nonce still only ever
 * re-proves that the same address signed the same message for the same domain
 * inside a ten-minute window. It cannot be pointed at another site (the domain
 * is in the signed text), it cannot name another address (the signature is over
 * that address), and it cannot outlive its expiry. A durable store — Postgres,
 * Redis — would close the last of it; this is what is available from inside the
 * function, and it closes the case that actually happens, which is the same
 * request arriving twice.
 */
const spent = new Set<string>();

/** Spent nonces held before the set starts forgetting the oldest. */
const MAX_SPENT = 10_000;

/** A nonce this server will recognise for the next {@link NONCE_TTL_MS}. */
export function mintNonce(now = Date.now()): string {
  const random = randomBytes(NONCE_RANDOM_HEX / 2).toString("hex");
  // Seconds rather than milliseconds: twelve hex digits of seconds runs to the
  // year 8.9 million, and it keeps the nonce inside a comfortable length.
  const expiry = Math.floor((now + NONCE_TTL_MS) / 1000)
    .toString(16)
    .padStart(NONCE_EXPIRY_HEX, "0");

  const body = random + expiry;
  return body + tag(body);
}

export type NonceCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether a nonce was issued here, is still inside its window, and is unspent.
 *
 * Spends it on the way through when all three hold — this is the only caller,
 * and a check that leaves the nonce usable is a check somebody will forget to
 * follow with a burn.
 */
export function claimNonce(nonce: string, now = Date.now()): NonceCheck {
  if (typeof nonce !== "string" || nonce.length !== NONCE_LENGTH) {
    return { ok: false, reason: "That sign-in request is not one this server issued." };
  }
  if (!/^[0-9a-f]+$/.test(nonce)) {
    return { ok: false, reason: "That sign-in request is not one this server issued." };
  }

  const body = nonce.slice(0, NONCE_RANDOM_HEX + NONCE_EXPIRY_HEX);
  const presented = nonce.slice(NONCE_RANDOM_HEX + NONCE_EXPIRY_HEX);

  if (!equalHex(presented, tag(body))) {
    return { ok: false, reason: "That sign-in request is not one this server issued." };
  }

  const expiresAt = Number.parseInt(body.slice(NONCE_RANDOM_HEX), 16) * 1000;
  if (!Number.isFinite(expiresAt) || now > expiresAt) {
    return { ok: false, reason: "That sign-in request expired. Try signing in again." };
  }

  if (spent.has(nonce)) {
    return { ok: false, reason: "That sign-in request was already used." };
  }

  if (spent.size >= MAX_SPENT) {
    // Insertion order, which is close enough to age when every entry has the
    // same lifetime. An evicted nonce is still bounded by its own expiry.
    const oldest = spent.values().next();
    if (!oldest.done) spent.delete(oldest.value);
  }
  spent.add(nonce);

  return { ok: true };
}

/**
 * A Supabase-compatible session for a proved address.
 *
 * The claims are the ones PostgREST insists on — `role` and `aud` must both be
 * `authenticated` or the request is treated as anonymous — plus `wallet`, which
 * is the whole point: `lib/schema.sql` compares it against the row being
 * inserted, and Postgres is where that comparison cannot be skipped.
 *
 * `sub` is derived from the address rather than random, so the same wallet is
 * the same subject across sessions. It is shaped as a UUID because that is what
 * Supabase's own helpers expect to find there; nothing in this app reads it.
 */
export function mintSession(
  address: string,
  now = Date.now()
): { token: string; expiresAt: number } {
  if (!JWT_SECRET) throw new Error("SUPABASE_JWT_SECRET is not set.");

  const wallet = address.toLowerCase();
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = Math.floor((now + SESSION_TTL_MS) / 1000);

  const token = signJwt(
    {
      sub: subjectFor(wallet),
      aud: "authenticated",
      role: "authenticated",
      iss: "folio-siwe",
      iat: issuedAt,
      exp: expiresAt,
      wallet,
      // Mirrored into the shape Supabase's client reads when it wants to show
      // who is signed in. Nothing is enforced from here — the policy reads the
      // top-level `wallet` claim — but a session that renders as an anonymous
      // one in a debugger costs an hour to somebody one day.
      user_metadata: { wallet },
      app_metadata: { provider: "siwe", providers: ["siwe"] },
    },
    JWT_SECRET
  );

  return { token, expiresAt: expiresAt * 1000 };
}

/** A stable UUID-shaped subject for an address. */
function subjectFor(wallet: string): string {
  const digest = createHash("sha256").update(`folio:siwe:${wallet}`).digest();

  // Version 8 (custom) and the RFC 4122 variant, so the string is a
  // well-formed UUID rather than a hex blob with hyphens in it.
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;

  const hex = digest.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * HS256, by hand.
 *
 * A JWT is a header, a payload and an HMAC over the two, all base64url. Writing
 * it out is about fifteen lines and no dependency; the alternative is pulling a
 * JOSE implementation into a build for one algorithm and one key. There is no
 * verification counterpart in this file on purpose — nothing here consumes a
 * JWT. Supabase does, with the same secret, and that is the only check that
 * matters.
 */
function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest();

  return `${header}.${body}.${base64url(signature)}`;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input as never)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The nonce's own tag, keyed by the same secret that signs sessions. */
function tag(body: string): string {
  return createHmac("sha256", JWT_SECRET ?? "")
    .update(`folio:nonce:${body}`)
    .digest("hex")
    .slice(0, NONCE_TAG_HEX);
}

/** Constant-time comparison of two equal-length hex strings. */
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
