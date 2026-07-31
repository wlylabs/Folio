/**
 * A fixed-window rate limiter, in memory.
 *
 * It guards the endpoints that spend somebody's money: a request to
 * /api/articles/draft reads three RSS feeds and buys a thousand tokens of
 * generation, and without a limit an open endpoint is a way for a stranger to
 * drain a Groq quota from a laptop.
 *
 * ## What this is not
 *
 * It is not a defence, and nothing here should be described as one. The counter
 * lives in the process, so it resets on every deploy and every cold start, and
 * a serverless deployment running four instances allows four times the limit.
 * A caller who wants past it changes IP.
 *
 * What it does buy is real anyway: it turns an accidental loop and a casual
 * curl-in-a-while-loop into an error instead of an invoice, which is the
 * failure that actually happens. The durable version of this is a shared
 * counter — Postgres or Redis — and it belongs here when the site has users
 * worth taking that from.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/**
 * Entries are only ever added on request, so an idle process holds whatever the
 * last burst left behind. Sweeping on write keeps that bounded without a timer
 * that would keep a serverless instance alive.
 */
const SWEEP_EVERY = 500;
let writes = 0;

export type RateLimitResult = {
  ok: boolean;
  /** Requests still allowed in this window. */
  remaining: number;
  /** Seconds until the window resets. For the Retry-After header. */
  retryAfter: number;
};

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();

  if (++writes % SWEEP_EVERY === 0) {
    for (const [k, window] of windows) if (window.resetAt <= now) windows.delete(k);
  }

  const existing = windows.get(key);
  const window =
    existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + windowMs };

  window.count += 1;
  windows.set(key, window);

  const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  return {
    ok: window.count <= limit,
    remaining: Math.max(0, limit - window.count),
    retryAfter,
  };
}

/**
 * The caller's address, as well as it can be known behind a proxy.
 *
 * `x-forwarded-for` is a client-settable header that only means anything
 * because the platform in front of this rewrites it — Vercel and most hosts
 * do. Self-hosted behind a proxy that doesn't, every caller looks like one
 * address and the limit applies to the whole site at once, which fails closed
 * rather than open.
 */
export function callerKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
