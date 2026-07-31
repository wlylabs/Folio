"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The password form.
 *
 * It posts to /api/desk/session and then refreshes rather than swapping itself
 * out for the composer: the server decides what /desk renders, and the server
 * is holding the only opinion that matters. A client that rendered the composer
 * on a successful fetch would be rendering it on its own say-so.
 */
export default function DeskUnlock() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !password) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/desk/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || `Could not unlock the desk (HTTP ${response.status}).`);
      }

      // Not kept in state a moment longer than the request needs it.
      setPassword("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not unlock the desk.");
      setBusy(false);
    }
  };

  return (
    <form className="stack" style={{ gap: "var(--sp-4)" }} onSubmit={submit}>
      <label className="field">
        <span className="field__label">Desk password</span>
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <span className="field__hint">
          The session lasts twelve hours and is signed with the password itself, so changing the
          password signs everyone out.
        </span>
      </label>

      {error && (
        <div className="notice notice--alert" role="alert">
          {error}
        </div>
      )}

      <button
        type="submit"
        className="btn btn--primary btn--block"
        disabled={busy || !password}
        data-busy={busy || undefined}
      >
        {busy ? "Working..." : "Unlock the desk"}
      </button>
    </form>
  );
}
