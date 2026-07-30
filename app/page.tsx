import Link from "next/link";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import SetupNotice from "@/components/SetupNotice";
import Mark from "@/components/Mark";
import { articleExcerpt } from "@/lib/sanitize";
import { chainLabel } from "@/lib/chains";
import { formatAmount, formatDateShort, type Token } from "@/lib/types";

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
    <main id="main">
      <header className="shell">
        <div className="masthead">
          <h1 className="masthead__wordmark">FOLIO</h1>
          <p className="masthead__tagline">Every token, told as a story</p>
          <div className="masthead__actions">
            <Link href="/create" className="btn btn--primary">
              Launch a token
            </Link>
            <Link href="/profile" className="btn btn--outline">
              Your desk
            </Link>
          </div>
        </div>
      </header>

      <div className="shell page">
        <div className="section-head">
          <h2 className="eyebrow">Latest listings</h2>
          {tokens.length > 0 && (
            <span className="eyebrow nums">
              {formatAmount(tokens.length)} published
            </span>
          )}
        </div>

        {tokens.length === 0 ? (
          <div className="empty">
            <p style={{ marginBottom: "var(--sp-4)" }}>
              Nothing has been published yet.
            </p>
            <Link href="/create" className="btn btn--primary">
              Launch the first one
            </Link>
          </div>
        ) : (
          <div className="feed">
            {tokens.map((t, i) => (
              // The newest launch runs as the lead story; the rest fill the
              // grid beneath it.
              <FeedCard key={t.id} token={t} lead={i === 0} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function FeedCard({ token, lead }: { token: Token; lead: boolean }) {
  const excerpt = articleExcerpt(token.article_body, lead ? 220 : 120);

  return (
    <Link
      href={`/token/${token.contract_address}`}
      className={`card${lead ? " card--lead" : ""}`}
    >
      <div className="card__meta">
        <Mark
          src={token.avatar_url}
          symbol={token.symbol}
          name={token.name}
          size={lead ? "lg" : "sm"}
        />
        <span className="card__kicker">
          {chainLabel(token.chain)} · ${token.symbol}
        </span>
      </div>

      <h3 className="card__title">{token.article_title || token.name}</h3>

      {excerpt && <p className="card__excerpt">{excerpt}</p>}

      <div className="card__foot">
        <span className="nums">{formatAmount(token.supply)} supply</span>
        <span className="nums">{formatDateShort(token.created_at)}</span>
      </div>
    </Link>
  );
}
