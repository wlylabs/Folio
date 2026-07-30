import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import TradeBar from "@/components/TradeBar";
import SetupNotice from "@/components/SetupNotice";
import Mark from "@/components/Mark";
import { sanitizeArticleHtml, articleExcerpt } from "@/lib/sanitize";
import { fetchSaleStats } from "@/lib/saleStats";
import { chainLabel, explorerAddressUrl } from "@/lib/chains";
import {
  formatAmount,
  formatDate,
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
        <a href={explorer} target="_blank" rel="noopener noreferrer" className="mono">
          {shortAddress(token.contract_address)}
        </a>
      ) : (
        <span className="mono">{shortAddress(token.contract_address)}</span>
      ),
    ],
    ["Symbol", `$${token.symbol}`],
    ["Total supply", formatAmount(stats.supply || token.supply)],
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
    <main id="main" className="shell page article">
      <div className="article__head">
        <p className="eyebrow">{chainLabel(token.chain)} · Token feature</p>

        <h1 className="article__title">{token.article_title}</h1>

        <div className="article__byline">
          <Mark
            src={token.avatar_url}
            symbol={token.symbol}
            name={token.name}
            size="sm"
          />
          <span>
            by{" "}
            <b className="mono" style={{ color: "var(--ink)" }}>
              {shortAddress(token.creator_wallet)}
            </b>
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatDate(token.created_at)}</span>
        </div>
      </div>

      <article
        className="article__body prose"
        // Sanitized server-side: article_body is written through the public
        // anon key, so it is untrusted input.
        dangerouslySetInnerHTML={{ __html: sanitizeArticleHtml(token.article_body) }}
      />

      <aside className="article__rail" aria-label="Sale data and trading">
        <section className="factbox">
          <h2 className="factbox__head">
            <span>Contract data</span>
            <span>Testnet</span>
          </h2>

          {/*
            Progress leads the box: the share sold is the one figure a reader
            scans for, and a bar says it faster than a percentage does.
          */}
          <div className="factbox__row" style={{ display: "block" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "var(--sp-3)",
                marginBottom: "var(--sp-2)",
              }}
            >
              <span className="factbox__label">
                Sold{stats.onChain ? "" : " (stored)"}
              </span>
              <span className="factbox__value">{formatPercent(stats.percentSold)}</span>
            </div>
            <div
              className="meter"
              role="progressbar"
              aria-label="Share of supply sold"
              aria-valuenow={Math.round(stats.percentSold)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="meter__fill" style={{ width: `${stats.percentSold}%` }} />
            </div>
          </div>

          {rows.map(([label, value]) => (
            <div key={label} className="factbox__row">
              <span className="factbox__label">{label}</span>
              <span className="factbox__value">{value}</span>
            </div>
          ))}
        </section>

        <TradeBar token={token} stats={stats} />
      </aside>
    </main>
  );
}
