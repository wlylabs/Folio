import Link from "next/link";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import SetupNotice from "@/components/SetupNotice";
import { articleExcerpt } from "@/lib/sanitize";
import { chainLabel } from "@/lib/chains";
import type { Token } from "@/lib/types";

export const revalidate = 0;

async function getTokens(): Promise<Token[]> {
  if (!isSupabaseConfigured) return [];

  const { data, error } = await supabase
    .from("tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("Failed to load the feed:", error);
    return [];
  }
  return (data as Token[]) ?? [];
}

export default async function HomePage() {
  if (!isSupabaseConfigured) return <SetupNotice />;

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
        <div
          className="font-ui"
          style={{ fontSize: 10, letterSpacing: 2, color: "var(--ink-soft)", paddingBottom: 12 }}
        >
          EVERY TOKEN, TOLD AS A STORY
        </div>
      </header>

      <div
        className="font-ui"
        style={{
          padding: "18px 20px 10px",
          fontSize: 10,
          letterSpacing: 2.5,
          color: "var(--ink-soft)",
        }}
      >
        LATEST LISTINGS
      </div>

      {tokens.length === 0 && (
        <p style={{ padding: "0 20px", color: "var(--ink-soft)", lineHeight: 1.7 }}>
          No tokens yet. <Link href="/create">Launch the first one</Link>.
        </p>
      )}

      {tokens.map((t) => {
        const excerpt = articleExcerpt(t.article_body, 120);
        return (
          <Link
            key={t.id}
            href={`/token/${t.contract_address}`}
            style={{ textDecoration: "none", color: "inherit", display: "block" }}
          >
            <article
              style={{
                display: "flex",
                gap: 12,
                padding: "16px 20px",
                borderBottom: "1px solid var(--rule)",
              }}
            >
              {t.avatar_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={t.avatar_url}
                  alt={`${t.name} avatar`}
                  width={48}
                  height={48}
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: "cover",
                    border: "1px solid var(--rule)",
                    flexShrink: 0,
                  }}
                />
              )}
              <div style={{ minWidth: 0 }}>
                <div className="font-ui" style={{ fontSize: 9, color: "var(--ink-soft)" }}>
                  {chainLabel(t.chain)} · ${t.symbol}
                </div>
                <div className="font-display" style={{ fontWeight: 700, fontSize: 21, lineHeight: 1.2 }}>
                  {t.article_title || t.name}
                </div>
                {excerpt && (
                  <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", lineHeight: 1.5 }}>
                    {excerpt}
                  </p>
                )}
              </div>
            </article>
          </Link>
        );
      })}
    </main>
  );
}
