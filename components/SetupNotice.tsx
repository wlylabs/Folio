/**
 * Shown instead of a crash when the Supabase env vars are missing, so a fresh
 * clone boots and explains itself rather than throwing.
 */
export default function SetupNotice() {
  return (
    <main id="main" className="shell shell--measure page">
      <p className="eyebrow">Setup required</p>
      <h1
        style={{
          fontWeight: 900,
          fontSize: "var(--fs-h1)",
          margin: "var(--sp-2) 0 var(--sp-4)",
        }}
      >
        Finish setting up Folio
      </h1>
      <p style={{ marginBottom: "var(--sp-5)", color: "var(--ink-soft)" }}>
        Supabase isn&apos;t configured yet, so there are no listings to show.
      </p>

      <ol
        className="font-ui"
        style={{
          fontSize: "var(--fs-ui)",
          lineHeight: 1.6,
          paddingLeft: "1.25rem",
          display: "flex",
          flexDirection: "column",
          gap: "var(--sp-3)",
          margin: 0,
        }}
      >
        <li>
          Copy <code>.env.example</code> to <code>.env.local</code>
        </li>
        <li>
          Fill in <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>
        </li>
        <li>
          Run <code>lib/schema.sql</code> in the Supabase SQL editor
        </li>
        <li>Restart the dev server</li>
      </ol>
    </main>
  );
}
