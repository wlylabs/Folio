"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { readConsent, writeConsent } from "@/lib/consent";

/**
 * The consent strip. Sits on the bottom edge, dismisses on either answer, and
 * never returns once answered.
 *
 * One detail it has to get right: it renders nothing on the first client pass.
 * localStorage cannot be read during SSR, so a banner rendered optimistically
 * would flash on every visit for readers who already answered. `decided` starts
 * undefined and the effect resolves it.
 */
export default function CookieBanner() {
  const [decided, setDecided] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    setDecided(readConsent() !== null);
  }, []);

  if (decided !== false) return null;

  function choose(value: "accepted" | "declined") {
    writeConsent(value);
    setDecided(true);
  }

  return (
    <aside
      className="consent"
      role="region"
      aria-label="Cookie preferences"
      // Polite: this is not an alert, and it must not interrupt a screen
      // reader mid-article to say so.
      aria-live="polite"
    >
      <div className="consent__inner">
        <p className="consent__copy">
          Folio keeps what it needs to work — the wallet you connected, nothing
          more. Optional analytics stay off unless you allow them.{" "}
          <Link href="/privacy">Read the privacy policy</Link>.
        </p>

        <div className="consent__actions">
          <button
            type="button"
            className="btn btn--outline btn--sm"
            onClick={() => choose("declined")}
          >
            Essential only
          </button>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => choose("accepted")}
          >
            Accept
          </button>
        </div>
      </div>
    </aside>
  );
}
