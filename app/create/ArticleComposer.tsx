"use client";

import { useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useAccount } from "wagmi";
import { useRouter } from "next/navigation";
import ModeSwitch from "./ModeSwitch";
import { TOPICS, TOPIC_LABEL, type Topic } from "@/lib/topics";

/**
 * Article mode: the desk agent writes, a person reads it, then it publishes.
 *
 * Two presses, not one. The agent is given headlines and asked for eight
 * hundred words about them, and that is exactly the job where a model produces
 * something confident and wrong — so the draft lands in an editor rather than
 * on the front page, and "Publish" is a separate decision made by someone who
 * has read it. `/api/articles/auto` is the unattended version for a scheduler,
 * and it is behind a secret precisely because it skips this step.
 *
 * Nothing here touches a wallet or a chain. A connected wallet is recorded as
 * the editor who published, and the form works the same without one.
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

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
    // Required in the App Router: rendering the editor during SSR causes a
    // hydration mismatch.
    immediatelyRender: false,
  });

  const busy = stage !== "idle";

  const generate = async () => {
    setStage("drafting");
    setError(null);

    try {
      const response = await fetch("/api/articles/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic, angle: angle.trim() || undefined }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || `The agent failed (HTTP ${response.status}).`);
      }

      const next = payload.draft as Draft;
      setDraft(next);
      setTitle(next.title);
      setExcerpt(next.excerpt);
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

      if (!response.ok) {
        throw new Error(payload.error || `Publishing failed (HTTP ${response.status}).`);
      }

      router.push(payload.path as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publishing failed.");
      setStage("idle");
    }
  };

  return (
    <main id="main" className="shell shell--form page">
      <ModeSwitch current="article" />

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
          that doesn&apos;t is a mistake worth catching here.
        </p>
      </header>

      <div className="stack" style={{ gap: "var(--sp-5)" }}>
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
          <button
            type="button"
            onClick={generate}
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
