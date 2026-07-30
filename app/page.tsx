import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";

export const revalidate = 0;

async function getTokens() {
  const { data, error } = await supabase
    .from("tokens")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    console.error(error);
    return [];
  }
  return data;
}

export default async function HomePage() {
  const tokens = await getTokens();

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", paddingBottom: 60 }}>
      <header
        style={{
          padding: "20px 20px 0",
          textAlign: "center",
          borderBottom: "1px solid var(--ink)",
        }}
      >
        <div className="font-display" style={{ fontWeight: 900, fontSize: 40 }}>
          FOLIO
        </div>
        <div className="font-ui" style={{ fontSize: 10, letterSpacing: 2, color: "var(--ink-soft)", paddingBottom: 12 }}>
          EVERY TOKEN, TOLD AS A STORY
        </div>
      </header>

      <div className="font-ui" style={{ padding: "18px 20px 10px", fontSize: 10, letterSpacing: 2.5, color: "var(--ink-soft)" }}>
        LATEST LISTINGS
      </div>

      {tokens.length === 0 && (
        <p style={{ padding: 20, color: "var(--ink-soft)" }}>
          Belum ada token. Jadilah yang pertama —{" "}
          <Link href="/create">buat token</Link>.
        </p>
      )}

      {tokens.map((t: any) => (
        <Link
          key={t.id}
          href={`/token/${t.contract_address}`}
          style={{ textDecoration: "none", color: "inherit" }}
        >
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--rule)" }}>
            <div className="font-ui" style={{ fontSize: 9, color: "var(--ink-soft)" }}>
              {t.chain.toUpperCase()} · ${t.symbol}
            </div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 21 }}>
              {t.article_title || t.name}
            </div>
          </div>
        </Link>
      ))}
    </main>
  );
}
