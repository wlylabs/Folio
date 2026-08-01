/*
 * The headers every response carries, and the reasoning behind each one.
 *
 * Plain CommonJS rather than TypeScript because next.config.js requires it
 * directly, and next.config.js is loaded before anything that could compile a
 * .ts file. Nothing else imports it.
 *
 * The policy is built from the environment rather than written out flat, for
 * one reason: the endpoints Folio talks to are configuration. A deploy that
 * points at a different Supabase project or a dedicated RPC would otherwise get
 * a Content-Security-Policy that blocks its own database, and the failure would
 * look like the site being broken rather than like a header being wrong.
 *
 * ---------------------------------------------------------------------------
 * If something breaks, read this before deleting the policy
 *
 * `CSP_REPORT_ONLY=1` switches the header to Content-Security-Policy-Report-Only.
 * The browser then reports every violation to the console and enforces none of
 * them, which is how to find out what a wallet actually needs on a preview
 * deploy without taking the site down to do it. `CSP_EXTRA_ORIGINS` (space
 * separated) adds hosts to the fetch directives for anything this file has not
 * heard of — a new RPC, an image CDN, an analytics endpoint.
 * ---------------------------------------------------------------------------
 */

/** Origins for the chains' default RPC endpoints. Mirrors lib/chains.ts —
 *  adding a chain there means adding its endpoint here, or the browser's
 *  fallback path to it is blocked. */
const DEFAULT_RPC_ORIGINS = ["https://rpc.mainnet.chain.robinhood.com"];

/**
 * Everything the wallet layer reaches for.
 *
 * These are not Folio's choices — they are what @rainbow-me/rainbowkit, wagmi
 * and the connectors underneath them call at connect time, and a policy that
 * omits one of them produces a connect button that opens a modal and then does
 * nothing. Wildcarded at the host level because each of these rotates
 * subdomains (relay, explorer, pulse, verify) on their own schedule.
 */
const WALLET_ORIGINS = [
  // WalletConnect's relay, its wallet registry, and Reown's AppKit.
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "wss://*.walletconnect.com",
  "wss://*.walletconnect.org",
  "https://*.reown.com",
  "wss://*.reown.com",
  // Coinbase Wallet's SDK, which does not use a relay of its own.
  "https://*.coinbase.com",
  "wss://*.coinbase.com",
  // MetaMask's SDK socket, for its mobile pairing.
  "https://*.metamask.io",
  "https://*.codefi.network",
  "wss://*.codefi.network",
];

/** Wallet icons and QR artwork come from the same registries. */
const WALLET_IMAGE_ORIGINS = [
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "https://*.reown.com",
];

/**
 * Where Folio may be framed.
 *
 * Not `'none'`, and that is deliberate: `safeWallet` is one of the three
 * connectors this app offers, and a Safe app *is* an iframe inside Safe's own
 * interface. `'none'` would leave that connector in the modal, unable to work
 * anywhere. Everything else is still refused, which is the clickjacking case
 * this is actually for. `CSP_FRAME_ANCESTORS` replaces the list — set it to
 * `'none'` on a deploy that does not want to be a Safe app at all.
 */
const DEFAULT_FRAME_ANCESTORS = ["'self'", "https://app.safe.global", "https://*.safe.global"];

/** An origin, from a URL, or null if it is not one. */
function originOf(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The same origin over websockets — Supabase Realtime dials wss on the host
 *  its REST API lives on. */
function websocketOf(origin) {
  if (!origin) return null;
  return origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/** Origins named by NEXT_PUBLIC_RPC_* — one per chain, set by the operator. */
function configuredRpcOrigins() {
  return Object.keys(process.env)
    .filter((key) => key.startsWith("NEXT_PUBLIC_RPC_"))
    .map((key) => originOf(process.env[key]));
}

function contentSecurityPolicy({ development }) {
  const supabase = originOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const extra = (process.env.CSP_EXTRA_ORIGINS || "").split(/\s+/).filter(Boolean);
  const rpc = unique([...configuredRpcOrigins(), ...DEFAULT_RPC_ORIGINS]);

  const connect = unique([
    "'self'",
    supabase,
    websocketOf(supabase),
    ...rpc,
    ...WALLET_ORIGINS,
    ...extra,
    // The dev server's own hot-reload socket.
    ...(development ? ["ws://localhost:*", "http://localhost:*"] : []),
  ]);

  const frameAncestors = process.env.CSP_FRAME_ANCESTORS
    ? process.env.CSP_FRAME_ANCESTORS.split(/\s+/).filter(Boolean)
    : DEFAULT_FRAME_ANCESTORS;

  const directives = {
    "default-src": ["'self'"],

    /*
     * `'unsafe-inline'`, and it is worth being honest about why rather than
     * quietly shipping it.
     *
     * Next's App Router serves every page with inline bootstrap scripts whose
     * content is the RSC payload — different on every render, so a hash cannot
     * cover them. The alternative is a per-request nonce, which means reading
     * headers() in the root layout, which opts *every* route in this app into
     * dynamic rendering: the about page, the legal pages and the share card
     * would all stop being prerendered to buy a stricter script-src. That is a
     * bad trade for a site whose scripts are all first-party and whose one
     * source of untrusted HTML (article bodies) is allowlist-sanitised on the
     * server before it is ever rendered — see lib/sanitize.ts.
     *
     * What this still buys, and it is not nothing: no script from another
     * origin can execute here at all. An injection that gets a <script src>
     * past the sanitiser is dead on arrival.
     *
     * No `'unsafe-eval'` in production. `'wasm-unsafe-eval'` is allowed because
     * some crypto paths compile a WebAssembly module and that is not the same
     * hole — it cannot turn a string into JavaScript.
     */
    "script-src": unique([
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      ...(development ? ["'unsafe-eval'"] : []),
    ]),

    // Inline styles are how this codebase expresses the handful of values it
    // computes at runtime — a progress width, a status colour — and how
    // RainbowKit ships its own. There is no XSS to prevent here that
    // script-src has not already prevented.
    "style-src": ["'self'", "'unsafe-inline'"],

    // Self-hosted by next/font; `data:` for anything inlined by the build.
    "font-src": ["'self'", "data:"],

    /*
     * Images are the one place a listing carries a URL that Folio did not
     * write: `avatar_url` is inserted through the public anon key and the
     * row-level policy does not constrain it (lib/schema.sql). Restricting
     * this to the storage bucket the launch form actually uploads to means a
     * hostile row cannot turn every reader's page view into a request to a
     * server of its choosing. components/Mark.tsx refuses the same thing a
     * second time, in the page.
     */
    "img-src": unique(["'self'", "data:", "blob:", supabase, ...WALLET_IMAGE_ORIGINS, ...extra]),

    "connect-src": connect,

    // Coinbase Wallet's SDK opens its own frame; WalletConnect's modal does
    // not. `blob:` is what a QR canvas is handed to.
    "frame-src": unique(["'self'", "blob:", "https://*.coinbase.com", "https://*.walletconnect.org"]),

    // The service worker, plus the blob workers some wallet SDKs spawn.
    "worker-src": ["'self'", "blob:"],

    "manifest-src": ["'self'"],
    "media-src": ["'self'"],

    // Nothing here embeds a plugin, and every one of these is a classic way to
    // smuggle script into a page that has none of its own.
    "object-src": ["'none'"],

    // A <base> tag rewrites what every relative URL on the page resolves
    // against, which turns one injected element into a rewrite of every link
    // and every script src on the page.
    "base-uri": ["'self'"],

    // No form on this site posts anywhere but here. A launch is signed by a
    // wallet, not submitted.
    "form-action": ["'self'"],

    "frame-ancestors": frameAncestors,
  };

  // Production is HTTPS; a mixed-content subresource is a mistake, not a
  // feature. Left off in development, where the dev server is plain http.
  const tail = development ? [] : ["upgrade-insecure-requests"];

  return [
    ...Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`),
    ...tail,
  ].join("; ");
}

/**
 * The full set, for next.config.js.
 *
 * Every one of these is a header a browser will act on without the site doing
 * anything else. There is no framework in here and nothing to keep in sync.
 */
function securityHeaders({ development = process.env.NODE_ENV !== "production" } = {}) {
  const reportOnly = process.env.CSP_REPORT_ONLY === "1";

  return [
    {
      key: reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy",
      value: contentSecurityPolicy({ development }),
    },

    // A response typed text/plain that a browser decides to treat as HTML is
    // how an upload becomes a script. This is the one-line end of that.
    { key: "X-Content-Type-Options", value: "nosniff" },

    /*
     * Same-origin navigations keep the full URL; anything leaving Folio sends
     * the origin alone.
     *
     * This site has URLs worth not leaking: /token/<address> names a contract,
     * and every outbound link in a listing is a link the author wrote. A block
     * explorer does not need to be told which listing sent the reader.
     */
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },

    /*
     * Features this page has no use for, turned off for the page and every
     * frame it embeds.
     *
     * `hid` and `usb` are conspicuously absent from the list: a hardware wallet
     * speaks over WebHID, and switching it off would break Ledger for the sake
     * of a header. `browsing-topics` is here because a launchpad has no
     * business being a signal in an advertising profile.
     */
    {
      key: "Permissions-Policy",
      value: [
        "accelerometer=()",
        "camera=()",
        "geolocation=()",
        "gyroscope=()",
        "magnetometer=()",
        "microphone=()",
        "payment=()",
        "browsing-topics=()",
        "interest-cohort=()",
      ].join(", "),
    },

    /*
     * `same-origin-allow-popups`, not `same-origin`.
     *
     * The stricter value severs `window.opener` for the popup a wallet SDK
     * opens, which is the channel the approval comes back through — Coinbase's
     * connector in particular. This still cuts every cross-origin page that
     * opened *us* out of our window group, which is the attack it is for.
     */
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },

    // Legacy clickjacking header deliberately omitted: X-Frame-Options has no
    // way to express "Safe's domain and nobody else", and `frame-ancestors`
    // above says exactly that in every browser released this decade.

    ...(development
      ? []
      : [
          {
            // Two years, subdomains included, and eligible for the preload
            // list. Folio is served over HTTPS everywhere it is deployed;
            // this is what stops the first request of a session from being
            // the one that is intercepted.
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ]),
  ];
}

module.exports = { securityHeaders };
