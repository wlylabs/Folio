import { NextResponse } from "next/server";
import {
  DESK_COOKIE,
  DESK_SESSION_SECONDS,
  isDeskConfigured,
  mintSession,
  passwordMatches,
} from "@/lib/desk";
import { callerKey, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `POST /api/desk/session` — unlock the article desk. `DELETE` — lock it again.
 *
 * The only place ARTICLE_DESK_PASSWORD is ever compared against anything. It
 * answers with a cookie, not with the password, and the cookie is signed rather
 * than a flag — see lib/desk.ts.
 *
 * The attempt limit is the point of the rate limit here, not cost: a password
 * short enough to type is short enough to guess at machine speed, and ten tries
 * a quarter hour turns that into a project. It is the in-memory limiter, so it
 * is a speed bump and not a lockout — the durable answer is a longer password,
 * which is free.
 */
const ATTEMPT_LIMIT = 10;
const ATTEMPT_WINDOW_MS = 15 * 60_000;

export async function POST(request: Request) {
  if (!isDeskConfigured()) {
    return NextResponse.json(
      {
        error:
          "No desk password is set, so the desk cannot be unlocked. Set ARTICLE_DESK_PASSWORD (at least 8 characters) — see .env.example.",
      },
      { status: 503 }
    );
  }

  const limit = rateLimit(`desk:${callerKey(request)}`, ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${limit.retryAfter}s.` },
      { status: 429, headers: { "retry-after": String(limit.retryAfter) } }
    );
  }

  let payload: { password?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const candidate = typeof payload.password === "string" ? payload.password : "";
  if (!passwordMatches(candidate)) {
    // Deliberately says nothing about which part was wrong, and nothing about
    // how many attempts remain — both are free information for whoever is
    // guessing.
    return NextResponse.json({ error: "That password does not open the desk." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, expiresIn: DESK_SESSION_SECONDS });
  response.cookies.set({
    name: DESK_COOKIE,
    value: mintSession(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DESK_SESSION_SECONDS,
  });
  return response;
}

/** Sign out. Clearing the cookie is the whole session — there is no server-side
 *  record of it to revoke, which is the trade a signed cookie makes. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: DESK_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
