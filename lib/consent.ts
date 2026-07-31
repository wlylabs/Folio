"use client";

/**
 * Cookie consent state.
 *
 * Worth being precise about what this actually gates, because right now the
 * honest answer is "nothing yet". Folio sets no analytics cookies and loads no
 * tracking script; the only browser storage in play is wagmi/RainbowKit
 * remembering which wallet you connected, which is what the banner calls
 * essential — it is the feature, not surveillance.
 *
 * So this module is the plumbing the privacy policy promises, put in before
 * the thing it governs. When analytics does arrive, it must mount behind
 * `hasAnalyticsConsent()` (see the note in app/layout.tsx) — the whole point is
 * that no tracking script loads before a reader has said yes.
 */

export const CONSENT_KEY = "folio_cookie_consent";

/** Fired on the window when the choice changes, so listeners in other trees update. */
export const CONSENT_EVENT = "folio:consent";

export type ConsentChoice = "accepted" | "declined";

export type ConsentRecord = {
  value: ConsentChoice;
  /** ISO 8601. A consent you cannot date is a consent you cannot honour a re-ask on. */
  at: string;
};

function isChoice(value: unknown): value is ConsentChoice {
  return value === "accepted" || value === "declined";
}

/**
 * The stored choice, or null if this reader has not answered yet.
 *
 * Returns null on the server and in any browser where localStorage throws —
 * Safari in private mode, storage disabled by policy. A reader whose choice
 * cannot be read is treated as one who has not consented.
 */
export function readConsent(): ConsentRecord | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(CONSENT_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;

    const { value, at } = parsed as Partial<ConsentRecord>;
    if (!isChoice(value)) return null;

    return { value, at: typeof at === "string" ? at : "" };
  } catch {
    // Unparseable or unreadable: treat as unanswered and ask again.
    return null;
  }
}

/** Record a choice and tell the rest of the page about it. */
export function writeConsent(value: ConsentChoice): ConsentRecord {
  const record: ConsentRecord = { value, at: new Date().toISOString() };

  try {
    window.localStorage.setItem(CONSENT_KEY, JSON.stringify(record));
  } catch {
    // Storage unavailable. The banner still dismisses for this page view; the
    // reader will be asked again next visit, which is the safe way to fail.
  }

  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: record }));
  return record;
}

/**
 * Whether non-essential/analytics storage is permitted. Anything that tracks
 * has to be behind this — and has to re-check on CONSENT_EVENT, because the
 * answer changes the moment the reader clicks.
 */
export function hasAnalyticsConsent(): boolean {
  return readConsent()?.value === "accepted";
}
