import { cookies } from "next/headers";
import Link from "next/link";
import ArticleComposer from "./ArticleComposer";
import DeskUnlock from "./DeskUnlock";
import { DESK_COOKIE, isDeskConfigured, sessionIsValid } from "@/lib/desk";

/**
 * `/desk` — the article desk, or the lock on it.
 *
 * The gate is here, on the server, and not only on the API routes behind it.
 * The routes are what actually enforces it — a page is a rendering decision and
 * an API is a permission — but rendering a composer to someone who cannot use
 * it is a form that fails on submit, and a form that fails on submit is a worse
 * way to say "not you" than a locked door.
 *
 * `force-dynamic` rather than relying on `cookies()` to opt this route out of
 * static rendering, and the difference is not academic: the cookie is only read
 * when a password is configured, so a build with ARTICLE_DESK_PASSWORD unset
 * never touches `cookies()`, never bails out of prerendering, and ships a
 * static "no password set" page that would still be saying it after the
 * variable was added. Declaring it is the version that cannot be short-
 * circuited by an environment.
 */
export const dynamic = "force-dynamic";

export default function DeskPage() {
  const configured = isDeskConfigured();
  const unlocked = configured && sessionIsValid(cookies().get(DESK_COOKIE)?.value);

  if (unlocked) return <ArticleComposer />;

  return (
    <main id="main" className="shell shell--form page">
      <header style={{ marginBottom: "var(--sp-5)" }}>
        <p className="eyebrow">Staff</p>
        <h1
          style={{ fontWeight: 900, fontSize: "var(--fs-h1)", margin: "var(--sp-2) 0 var(--sp-3)" }}
        >
          Article desk
        </h1>
        <p style={{ color: "var(--ink-soft)", maxWidth: "var(--measure)" }}>
          Where Folio&apos;s agent drafts from the wires and a person publishes what it wrote.
          Everything it has published is public at <Link href="/read">/read</Link>. To publish
          something of your own, the door is the <Link href="/create">launchpad</Link> — an article
          and the token it describes, in one transaction.
        </p>
      </header>

      {configured ? (
        <DeskUnlock />
      ) : (
        <div className="notice notice--alert" role="alert">
          The desk has no password set, so it cannot be unlocked. Set{" "}
          <code>ARTICLE_DESK_PASSWORD</code> to at least eight characters and restart — see{" "}
          <code>.env.example</code>. It stays locked until then rather than falling open.
        </div>
      )}
    </main>
  );
}
