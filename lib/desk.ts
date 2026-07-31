import { createHmac, timingSafeEqual, createHash } from "node:crypto";

/**
 * The lock on the article desk.
 *
 * Article mode and launchpad mode are two different offers to two different
 * people. The launchpad is public and always was: it costs gas, it needs a
 * signature, and the chain is the thing rate-limiting it. The article desk is
 * not — it spends a model quota and writes straight to the front page for free,
 * so "whoever finds the URL" is the wrong answer to who may press the button.
 * Everyone else reads what the desk published at /read.
 *
 * ## Why a password and not a wallet
 *
 * A wallet signature would prove which address pressed publish, and prove
 * nothing about whether that address should have been allowed to. Gating on an
 * allowlist of addresses means maintaining an allowlist, and gating on "any
 * connected wallet" means gating on nothing at all — a wallet costs a stranger
 * one click to make. One shared secret held by the people who run the desk is
 * the honest shape of "staff only" for a publication this size, and it is the
 * same shape ARTICLE_AGENT_SECRET already has for the unattended agent.
 *
 * ## The session
 *
 * The password is never stored in a cookie. Unlocking mints
 * `<expiry>.<hmac>`, signed with the password itself as the key, and that is
 * what the browser holds — so the cookie cannot be replayed past its expiry,
 * cannot be extended by editing it, and every session dies the moment the
 * password is rotated. It is httpOnly: no script on the page needs to read it,
 * and one that wants to is not one we are writing for.
 *
 * ## It does not fall open
 *
 * With ARTICLE_DESK_PASSWORD unset, every desk route refuses with a 503 that
 * says what to set — the same choice /api/articles/auto makes, and for the same
 * reason. A deployment that forgot the variable gets a locked desk, not an open
 * one, because the failure of an unset password is silent and permanent while
 * the failure of a locked desk is a message on a screen.
 */

/** Read from the environment on every call: a route may run in a process that
 *  started before the variable was set, and reading it late costs nothing. */
function password(): string {
  return process.env.ARTICLE_DESK_PASSWORD?.trim() ?? "";
}

export const DESK_COOKIE = "folio_desk";

/** Long enough for an editing session, short enough that a laptop left open in
 *  a cafe is not a standing invitation. */
export const DESK_SESSION_SECONDS = 12 * 60 * 60;

/** A password shorter than this is not a lock. */
const MIN_PASSWORD_LENGTH = 8;

export function isDeskConfigured(): boolean {
  return password().length >= MIN_PASSWORD_LENGTH;
}

/**
 * The password check.
 *
 * Both sides are hashed before comparison so the comparison is over two equal
 * fixed-length buffers — `timingSafeEqual` throws on a length mismatch, and
 * catching that would leak the password's length through the error path it
 * exists to close.
 */
export function passwordMatches(candidate: string): boolean {
  const secret = password();
  if (!secret) return false;

  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** A signed session value for the cookie, valid for {DESK_SESSION_SECONDS}. */
export function mintSession(now = Date.now()): string {
  const expiresAt = now + DESK_SESSION_SECONDS * 1000;
  return `${expiresAt}.${sign(expiresAt)}`;
}

/** True when `value` is a session this deployment signed and has not expired. */
export function sessionIsValid(value: string | undefined | null, now = Date.now()): boolean {
  if (!value || !isDeskConfigured()) return false;

  const separator = value.indexOf(".");
  if (separator === -1) return false;

  const expiresAt = Number(value.slice(0, separator));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const presented = Buffer.from(value.slice(separator + 1), "utf8");
  const expected = Buffer.from(sign(expiresAt), "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function sign(expiresAt: number): string {
  return createHmac("sha256", password()).update(`folio-desk.v1.${expiresAt}`).digest("base64url");
}

/**
 * The desk session on a request, read straight off the Cookie header.
 *
 * Route handlers here take a plain `Request`, so this parses rather than
 * reaching for NextRequest.cookies — the same function then works for a route
 * handler and for anything else holding a fetch Request.
 */
export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== DESK_COOKIE) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function hasDeskSession(request: Request): boolean {
  return sessionIsValid(readSessionCookie(request));
}

export type DeskDenial = { status: 401 | 503; error: string };

/**
 * Why this request may not use the desk, or null when it may.
 *
 * Returns the pieces of a response rather than a NextResponse so the routes
 * keep their own error shape, and so this module stays testable without a
 * framework around it.
 */
export function deskDenial(request: Request): DeskDenial | null {
  if (!isDeskConfigured()) {
    return {
      status: 503,
      error:
        "The article desk is locked and has no password to unlock it. Set ARTICLE_DESK_PASSWORD (at least 8 characters) — see .env.example.",
    };
  }
  if (!hasDeskSession(request)) {
    // One message for "never had a session" and "had one that ran out": the
    // difference is not something the caller can act on differently, and
    // spelling it out tells whoever is probing which of the two they hit.
    return {
      status: 401,
      error: "The article desk is locked. Unlock it at /desk — a session lasts twelve hours.",
    };
  }
  return null;
}
