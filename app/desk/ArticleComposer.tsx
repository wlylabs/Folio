"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useAccount } from "wagmi";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { TOPICS, TOPIC_LABEL, type Topic } from "@/lib/topics";

/**
 * The article desk: the agent writes, a person reads it, then it publishes.
 *
 * Two presses, not one. The agent is given headlines and asked for eight
 * hundred words about them, and that is exactly the job where a model produces
 * something confident and wrong — so the draft lands in an editor rather than
 * on the front page, and "Publish" is a separate decision made by someone who
 * has read it. `/api/articles/auto` is the unattended version for a scheduler,
 * and it is behind a secret precisely because it skips this step.
 *
 * Staff only, and the routes behind it enforce that (lib/desk.ts). This is not
 * the launchpad: nothing here touches a wallet or a chain, and a reader who
 * wants to publish something of their own goes to /create, where the article
 * comes with a token and a transaction. A connected wallet is recorded as the
 * editor who published, and the form works the same without one.
 *
 * ## The draft survives the tab
 *
 * A draft is a minute of generation and however long its review took, and it
 * lived in React state alone — a refresh, a stray back gesture or an expired
 * session took all of it. It is now written to localStorage as it is edited and
 * restored on the way back in. Only ever local: it is unpublished copy, and the
 * only place it belongs before publish is the machine of the person reviewing
 * it.
 */

/** Mirrors the JSON `/api/articles/draft` returns. */
type Draft = {
  title: string;
  slug: string;
  excerpt: string;
  topic: Topic;
  tags: string[];
  bodyHtml: string;
  sources: { title: string; url: string; publisher: string; published_at: string | null }[];
  model: string;
  provider: string;
  fallbacks: { provider: string; reason: string }[];
};

type Stage = "idle" | "drafting" | "publishing";

const STAGE_LABEL: Record<Exclude<Stage, "idle">, string> = {
  drafting: "Reading the wires and writing the piece — this takes up to a minute...",
  publishing: "Publishing...",
};

/**
 * Versioned, because the shape below is the shape of a `Draft`, and a stored
 * object from an older shape restored into a newer composer is a crash on a
 * field that is not there. A bumped suffix is ignored rather than parsed.
 */
const STORAGE_KEY = "folio.desk.draft.v1";

/** Long enough to come back after lunch, short enough that a draft written
 *  against a fortnight-old feed is not silently reopened. */
const STORAGE_MAX_AGE_MS = 3 * 86_400_000;

type StoredDraft = {
  savedAt: number;
  draft: Draft;
  title: string;
  excerpt: string;
  body: string;
};

export default function ArticleComposer() {
  const { address, isConnected } = useAccount();
  const router = useRouter();

  const [topic, setTopic] = useState<Topic>("ai");
  const [angle, setAngle] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Set when this session opened with a draft left over from a previous one. */
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  /** The discard press is one press away from destroying a reviewed draft, so
   *  it asks. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  /** Bumped on every keystroke in the editor, purely to retrigger the save
   *  below — the body itself stays in ProseMirror rather than in React state. */
  const [bodyRevision, setBodyRevision] = useState(0);

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    // Required in the App Router: rendering the editor during SSR causes a
    // hydration mismatch.
    immediatelyRender: false,
    onUpdate: () => setBodyRevision((revision) => revision + 1),
  });

  const busy = stage !== "idle";

  /* ---------------------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------------------- */

  const restored = useRef(false);

  useEffect(() => {
    // The editor is null on the first render and the body has to go somewhere,
    // so the restore waits for it. `restored` guards against a second pass when
    // the editor instance changes for any other reason.
    if (!editor || restored.current) return;
    restored.current = true;

    const stored = readStoredDraft();
    if (!stored) return;

    setDraft(stored.draft);
    setTitle(stored.title);
    setExcerpt(stored.excerpt);
    setTopic(stored.draft.topic);
    editor.commands.setContent(stored.body);
    setRestoredAt(stored.savedAt);
  }, [editor]);

  useEffect(() => {
    if (!draft || !editor) return;

    // Debounced: this runs on every keystroke, and localStorage is synchronous
    // on the main thread.
    const timer = setTimeout(() => {
      writeStoredDraft({ savedAt: Date.now(), draft, title, excerpt, body: editor.getHTML() });
    }, 600);
    return () => clearTimeout(timer);
  }, [draft, title, excerpt, bodyRevision, editor]);

  const discard = useCallback(() => {
    clearStoredDraft();
    setDraft(null);
    setTitle("");
    setExcerpt("");
    setRestoredAt(null);
    setConfirmingDiscard(false);
    setError(null);
    editor?.commands.clearContent();
  }, [editor]);

  /* ---------------------------------------------------------------------- *
   * The two presses
   * ---------------------------------------------------------------------- */

  /**
   * A 401 means the twelve hours ran out mid-session. Refreshing renders the
   * lock in this component's place, so the save is flushed first rather than
   * left to the debounce — the last thing typed before the session died is
   * exactly the thing worth keeping — and unlocking restores what was on
   * screen.
   */
  const handleExpiry = () => {
    if (draft && editor) {
      writeStoredDraft({ savedAt: Date.now(), draft, title, excerpt, body: editor.getHTML() });
    }
    setError("The desk session expired. Unlock it again — your draft is saved.");
    router.refresh();
  };

  const generate = async () => {
    setStage("drafting");
    setError(null);
    setConfirmingDiscard(false);

    try {
      const response = await fetch("/api/articles/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic, angle: angle.trim() || undefined }),
      });
      const payload = await response.json().catch(() => ({}));

      if (response.status === 401) {
        handleExpiry();
        return;
      }
      if (!response.ok) {
        throw new Error(payload.error || `The agent failed (HTTP ${response.status}).`);
      }

      const next = payload.draft as Draft;
      setDraft(next);
      setTitle(next.title);
      setExcerpt(next.excerpt);
      setRestoredAt(null);
      editor?.commands.setContent(next.bodyHtml);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The agent failed.");
    } finally {
      setStage("idle");
    }
  };

  const publish = async () => {
    if (!draft || !editor) return;

    const headline = title.trim();
    if (!headline) {
      setError("An article needs a headline.");
      return;
    }
    if (editor.isEmpty) {
      setError("The article body is empty.");
      return;
    }

    setStage("publishing");
    setError(null);

    try {
      const response = await fetch("/api/articles/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: headline,
          // The slug follows the headline when the headline was edited, so a
          // corrected title does not leave the model's wording in the URL —
          // where, unlike the headline, it can never be changed afterwards.
          slug: headline === draft.title ? draft.slug : undefined,
          excerpt: excerpt.trim() || undefined,
          body: editor.getHTML(),
          topic: draft.topic,
          tags: draft.tags,
          sources: draft.sources,
          model: draft.model,
          authorWallet: address ?? null,
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (response.status === 401) {
        handleExpiry();
        setStage("idle");
        return;
      }
      if (!response.ok) {
        throw new Error(payload.error || `Publishing failed (HTTP ${response.status}).`);
      }

      // It is a page now, so the local copy has served its purpose. Cleared
      // before navigating, or coming back to the desk restores a draft that is
      // already published.
      clearStoredDraft();
      router.push(payload.path as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publishing failed.");
      setStage("idle");
    }
  };

  return (
    <main id="main" className="shell shell--form page">
      <DeskBar />

      <header style={{ marginBottom: "var(--sp-5)" }}>
        <p className="eyebrow">Article desk</p>
        <h1
          style={{ fontWeight: 900, fontSize: "var(--fs-h1)", margin: "var(--sp-2) 0 var(--sp-3)" }}
        >
          Write an article
        </h1>
        <p style={{ color: "var(--ink-soft)", maxWidth: "var(--measure)" }}>
          The desk agent reads what AI, technology and crypto outlets syndicated today and writes
          one piece about the thread running through them — attributed, in Folio&apos;s house style,
          shaped for search. It works from headlines and summaries only, so read it before you
          publish it: everything it says traces to the sources listed under the draft, and anything
          that doesn&apos;t is a mistake worth catching here. Stories a recent article already cited
          are taken out of the feed before the agent sees them, so it does not write the same piece
          twice.
        </p>
      </header>

      <div className="stack" style={{ gap: "var(--sp-5)" }}>
        {restoredAt && (
          <div className="notice" role="status">
            <p className="notice__title">Picked up where you left off</p>
            An unpublished draft from {formatSaved(restoredAt)} was restored, with your edits.{" "}
            <button type="button" className="btn btn--plain" onClick={discard}>
              Discard it
            </button>
          </div>
        )}

        <div>
          <span className="field__label">Beat</span>
          <div
            className="chip-row"
            role="group"
            aria-label="Beat"
            style={{ marginTop: "var(--sp-2)" }}
          >
            {TOPICS.map((option) => (
              <button
                key={option}
                type="button"
                className="chip"
                aria-pressed={option === topic}
                disabled={busy}
                onClick={() => setTopic(option)}
              >
                {TOPIC_LABEL[option]}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="field__label">Angle</span>
          <input
            className="input"
            placeholder="Optional — e.g. what this means for open models"
            value={angle}
            onChange={(e) => setAngle(e.target.value)}
            disabled={busy}
            maxLength={300}
          />
          <span className="field__hint">
            A steer, not a subject. The agent still writes from today&apos;s headlines.
          </span>
        </label>

        <div>
          {/*
            With a draft on screen this button destroys it, and it sits where a
            reviewer's hand already is. So it asks first — once, inline, with
            the safe option present rather than as a browser confirm nobody
            reads.
          */}
          {confirmingDiscard ? (
            <div className="notice notice--alert" role="alert">
              <p className="notice__title">Discard this draft?</p>
              The article and every edit you made to it go with it. The next one is written from
              scratch.
              <div
                style={{ display: "flex", gap: "var(--sp-3)", marginTop: "var(--sp-3)" }}
              >
                <button type="button" className="btn btn--alert btn--sm" onClick={generate}>
                  Discard and write another
                </button>
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  onClick={() => setConfirmingDiscard(false)}
                >
                  Keep editing
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={draft ? () => setConfirmingDiscard(true) : generate}
              disabled={busy}
              className={`btn ${draft ? "btn--outline" : "btn--primary"} btn--block`}
              data-busy={stage === "drafting" || undefined}
            >
              {stage === "drafting"
                ? "Working..."
                : draft
                  ? "Discard and write another"
                  : `Write a ${TOPIC_LABEL[topic]} article`}
            </button>
          )}
        </div>

        {busy && (
          <p className="status" role="status">
            {STAGE_LABEL[stage as Exclude<Stage, "idle">]}
          </p>
        )}

        {error && (
          <div className="notice notice--alert" role="alert">
            {error}
          </div>
        )}

        {draft && (
          <>
            <div className="form-grid">
              <Field label="Headline" hint="60–70 characters reads best in a search result" wide>
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={busy}
                  maxLength={200}
                />
              </Field>

              <Field
                label="Meta description"
                hint="What a search result shows under the headline. Kept to 155 characters."
                wide
              >
                <input
                  className="input"
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  disabled={busy}
                  maxLength={155}
                />
              </Field>

              <Field label="Article" hint="Edit anything here before it becomes a page" wide>
                <div className={`editor${editor?.isEmpty ? " editor--empty" : ""}`}>
                  <EditorContent editor={editor} />
                </div>
              </Field>
            </div>

            <section className="factbox">
              <h2 className="factbox__head">
                <span>Written from</span>
                <span>{draft.model}</span>
              </h2>
              {/*
                The sources are the article's evidence, and they publish with
                it — every one of these appears at the foot of the finished
                page. They are shown here at full length so a fabricated claim
                in the draft can be checked against the headline it came from
                before anyone else reads it.
              */}
              <ul className="sources">
                {draft.sources.map((source) => (
                  <li key={source.url} className="sources__item">
                    <a href={source.url} target="_blank" rel="nofollow noopener noreferrer">
                      {source.title}
                    </a>
                    <span className="sources__publisher">{source.publisher}</span>
                  </li>
                ))}
              </ul>
              {draft.tags.length > 0 && (
                <div className="factbox__row">
                  <span className="factbox__label">Tags</span>
                  <span className="factbox__value">{draft.tags.join(", ")}</span>
                </div>
              )}
              {draft.fallbacks.length > 0 && (
                <p className="field__hint" style={{ marginTop: "var(--sp-3)" }}>
                  {draft.fallbacks.map((f) => f.provider).join(", ")} did not answer, so{" "}
                  {draft.provider} wrote this one.
                </p>
              )}
            </section>

            <div>
              <button
                type="button"
                onClick={publish}
                disabled={busy}
                className="btn btn--primary btn--block"
                data-busy={stage === "publishing" || undefined}
              >
                {stage === "publishing" ? "Working..." : "Publish article"}
              </button>
              <p className="field__hint" style={{ marginTop: "var(--sp-3)" }}>
                {isConnected
                  ? "Published under your wallet as the editor. No transaction, no gas — the byline still names the model that wrote it."
                  : "No wallet needed. Connect one first if you want to be recorded as the editor who published it."}
              </p>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/**
 * The strip that says which desk you are at and lets you leave it.
 *
 * Where ModeSwitch used to be, and deliberately not a switch: the launchpad is
 * not the other setting of this page, it is the public half of the site. The
 * link out is a link out.
 */
function DeskBar() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetch("/api/desk/session", { method: "DELETE" });
    } catch {
      // The cookie may or may not be gone; the refresh below is what shows
      // which, and the server is the one that decides.
    }
    router.refresh();
    setSigningOut(false);
  };

  return (
    <div className="desk-bar">
      <span className="desk-bar__label">Staff · article desk</span>
      <span className="desk-bar__links">
        <Link href="/create">Launchpad</Link>
        <Link href="/postfolio">Published</Link>
        <button type="button" className="btn btn--plain" onClick={signOut} disabled={signingOut}>
          {signingOut ? "Signing out..." : "Sign out"}
        </button>
      </span>
    </div>
  );
}

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`field${wide ? " field--wide" : ""}`}>
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

/* ========================================================================== *
 * localStorage
 *
 * Every one of these is wrapped: localStorage throws rather than returning
 * null in a private window on some browsers and when the origin's quota is
 * full, and losing the autosave is not worth losing the composer over.
 * ========================================================================== */

function readStoredDraft(): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const stored = JSON.parse(raw) as Partial<StoredDraft>;
    const draft = stored.draft;
    if (!draft || typeof draft !== "object" || typeof draft.bodyHtml !== "string") return null;
    if (!Array.isArray(draft.sources) || !Array.isArray(draft.tags)) return null;
    if (typeof stored.savedAt !== "number" || Date.now() - stored.savedAt > STORAGE_MAX_AGE_MS) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return {
      savedAt: stored.savedAt,
      draft,
      title: typeof stored.title === "string" ? stored.title : draft.title,
      excerpt: typeof stored.excerpt === "string" ? stored.excerpt : draft.excerpt,
      body: typeof stored.body === "string" ? stored.body : draft.bodyHtml,
    };
  } catch {
    return null;
  }
}

function writeStoredDraft(value: StoredDraft): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* A draft that could not be saved is still a draft on screen. */
  }
}

function clearStoredDraft(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing to do about it, and nothing depends on it having worked. */
  }
}

/** "today at 14:02" reads faster than a date stamp for something saved hours
 *  ago, which is what this always is. */
function formatSaved(savedAt: number): string {
  const saved = new Date(savedAt);
  const time = saved.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date().toDateString() === saved.toDateString();
  return sameDay ? `today at ${time}` : `${saved.toLocaleDateString()} at ${time}`;
}
