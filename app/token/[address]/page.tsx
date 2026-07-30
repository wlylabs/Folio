import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import TradeBar from "@/components/TradeBar";
import SetupNotice from "@/components/SetupNotice";
import { sanitizeArticleHtml, articleExcerpt } from "@/lib/sanitize";
import { fetchSaleStats } from "@/lib/saleStats";
import { chainLabel, explorerAddressUrl } from "@/lib/chains";
import {
  formatAmount,
  formatEth,
  formatPercent,
  shortAddress,
  type Token,
} from "@/lib/types";

// Sale figures change with every purchase, so never serve a cached page.
export const dynamic = "force-dynamic";
export const revalidate = 0;

async function getToken(address: string): Promise<Token | null> {
  if (!isSupabaseConfigured) return null;

  // Addresses are stored lowercased; a URL with checksum casing must still
  // resolve.
  const { data, error } = await supabase
    .from("tokens")
    .select("*")
    .eq("contract_address", address.toLowerCase())
    .maybeSingle();

  if (error) {
    console.error("Failed to load token:", error);
    return null;
  }
  return (data as Token | null) ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: { address: string };
}): Promise<Metadata> {
  const token = await getToken(params.address);
  if (!token) return { title: "Token not found — Folio" };

  return {
    title: `${token.article_title} — Folio`,
    description: articleExcerpt(token.article_body),
  };
}

export default async function TokenPage({
  params,
}: {
  params: { address: string };
}) {
  if (!isSupabaseConfigured) return <SetupNotice />;

  const token = await getToken(params.address);
  if (!token) return notFound();

  const stats = await fetchSaleStats(token);
  const explorer = explorerAddressUrl(token.chain, token.contract_address);

  const rows: [string, React.ReactNode][] = [
    [
      "Contract",
      explorer ? (
        <a href={explorer} target="_blank" rel="noopener noreferrer">
          {shortAddress(token.contract_address)}
        </a>
      ) : (
        shortAddress(token.contract_address)
      ),
    ],
    ["Symbol", `$${token.symbol}`],
    ["Total supply", formatAmount(stats.supply || token.supply)],
    ["Sold", `${formatPercent(stats.percentSold)}${stats.onChain ? "" : " (stored)"}`],
    ["Buy price", `${formatEth(Number(token.starting_price))} ETH`],
    [
      "Sell price",
      stats.buyback ? `${formatEth(stats.buyback.sellPrice)} ETH` : "no buyback",
    ],
  ];

  // The reserve is what makes the sell button more than a promise, so it is
  // printed next to the price rather than left for the explorer to reveal.
  if (stats.buyback) {
    rows.push(["Buyback reserve", `${formatEth(stats.buyback.reserve)} ETH`]);
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", paddingBottom: 140 }}>
      <div style={{ padding: "16px 20px 0" }}>
        <div className="font-ui" style={{ fontSize: 9.5, letterSpacing: 2, color: "var(--ink-soft)" }}>
          {chainLabel(token.chain)} · TOKEN FEATURE
        </div>

        <h1 className="font-display" style={{ fontWeight: 900, fontSize: 30, lineHeight: 1.15, margin: "10px 0" }}>
          {token.article_title}
        </h1>

        <div
          className="font-ui"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 0",
            borderTop: "1px solid var(--ink)",
            borderBottom: "1px solid var(--rule)",
            marginBottom: 16,
            fontSize: 10,
            color: "var(--ink-soft)",
          }}
        >
          {token.avatar_url && (
            // Plain <img>: next/image is deliberately unused, see next.config.js.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={token.avatar_url}
              alt={`${token.name} avatar`}
              width={28}
              height={28}
              style={{ width: 28, height: 28, objectFit: "cover", border: "1px solid var(--rule)" }}
            />
          )}
          <span>
            by <b style={{ color: "var(--ink)" }}>{shortAddress(token.creator_wallet)}</b>
          </span>
          <span>· {formatDate(token.created_at)}</span>
        </div>

        <div
          style={{ fontSize: 15.5, lineHeight: 1.75 }}
          // Sanitized server-side: article_body is written through the public
          // anon key, so it is untrusted input.
          dangerouslySetInnerHTML={{ __html: sanitizeArticleHtml(token.article_body) }}
        />

        <div style={{ margin: "22px 0", border: "1px solid var(--ink)" }}>
          <div
            className="font-ui"
            style={{
              fontSize: 9.5,
              letterSpacing: 2,
              background: "var(--ink)",
              color: "var(--paper)",
              padding: "8px 12px",
            }}
          >
            CONTRACT DATA · TESTNET
          </div>
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="font-ui"
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: "9px 12px",
                borderBottom: "1px solid var(--rule)",
                fontSize: 11.5,
              }}
            >
              <span style={{ color: "var(--ink-soft)" }}>{label}</span>
              <span style={{ fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      <TradeBar token={token} stats={stats} />
    </main>
  );
}

function formatDate(value: string | null): string {
  if (!value) return "undated";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "undated"
    : date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
