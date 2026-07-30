/**
 * Shown instead of a crash when the Supabase env vars are missing, so a fresh
 * clone boots and explains itself rather than throwing.
 */
export default function SetupNotice() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "40px 20px" }}>
      <h1 className="font-display" style={{ fontWeight: 900, fontSize: 26, marginBottom: 12 }}>
        Finish setting up Folio
      </h1>
      <p style={{ fontSize: 15, lineHeight: 1.7, marginBottom: 16 }}>
        Supabase isn&apos;t configured yet, so there are no listings to show.
      </p>
      <ol className="font-ui" style={{ fontSize: 12.5, lineHeight: 2, paddingLeft: 20 }}>
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
