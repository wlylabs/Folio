import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import TradeBar from "@/components/TradeBar";
import SetupNotice from "@/components/SetupNotice";
import Mark from "@/components/Mark";
import { sanitizeArticleHtml, articleExcerpt } from "@/lib/sanitize";
import { fetchTokenStats } from "@/lib/tokenStats";
import { chainLabel, explorerAddressUrl } from "@/lib/chains";
import {
  formatAmount,
  formatBps,
  formatDate,
  formatEth,
  formatPercent,
  shortAddress,
  type Token,
  type TokenStats,
} from "@/lib/types";

// Curve figures change with every trade, so never serve a cached page.
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

  const stats = await fetchTokenStats(token);
  const explorer = explorerAddressUrl(token.chain, token.contract_address);

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

      <aside className="article__rail" aria-label="Curve data and trading">
        <section className="factbox">
          <h2 className="factbox__head">
            <span>Contract data</span>
            <span>Testnet</span>
          </h2>

          {/*
            Progress leads the box: the share of supply the curve has issued is
            the one figure a reader scans for, and a bar says it faster than a
            percentage does.
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
                Issued{stats.onChain ? "" : " (stored)"}
              </span>
              <span className="factbox__value">{formatPercent(stats.percentSold)}</span>
            </div>
            <div
              className="meter"
              role="progressbar"
              aria-label="Share of supply issued"
              aria-valuenow={Math.round(stats.percentSold)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="meter__fill" style={{ width: `${stats.percentSold}%` }} />
            </div>
          </div>

          {factRows(token, stats, explorer).map(([label, value]) => (
            <div key={label} className="factbox__row">
              <span className="factbox__label">{label}</span>
              <span className="factbox__value">{value}</span>
            </div>
          ))}

          {/*
            Reserve health is the sell-back guarantee stated as one number:
            10000 bps means the reserve exactly covers every token in
            circulation. Below that would mean the curve owes more than it holds,
            which the contract's maths does not permit — so it is worth saying
            out loud when it holds, and worth alarming on if it ever doesn't.
          */}
          {stats.kind === "curve" && (
            <p className="field__hint" style={{ marginTop: "var(--sp-3)" }}>
              {stats.reserveHealthBps >= 10_000
                ? `Reserve covers ${formatPercent(stats.reserveHealthBps / 100)} of what the curve owes holders — every token in circulation can be sold back.`
                : `Reserve covers only ${formatPercent(
                    stats.reserveHealthBps / 100
                  )} of what the curve owes holders. Trade with care.`}
            </p>
          )}
        </section>

        <TradeBar token={token} stats={stats} />
      </aside>
    </main>
  );
}

/** The fact rows, which differ by what kind of contract is actually there. */
function factRows(
  token: Token,
  stats: TokenStats,
  explorer: string | null
): [string, React.ReactNode][] {
  const contractRow: [string, React.ReactNode] = [
    "Contract",
    explorer ? (
      <a href={explorer} target="_blank" rel="noopener noreferrer" className="mono">
        {shortAddress(token.contract_address)}
      </a>
    ) : (
      <span className="mono">{shortAddress(token.contract_address)}</span>
    ),
  ];

  if (stats.kind === "curve") {
    const rows: [string, React.ReactNode][] = [
      contractRow,
      ["Symbol", `$${token.symbol}`],
      ["Max supply", formatAmount(stats.supply)],
      ["In circulation", formatAmount(stats.sold)],
      ["Price now", `${formatEth(stats.price)} ETH`],
      ["Market cap", `${formatEth(stats.marketCap)} ETH`],
      ["Reserve", `${formatEth(stats.reserve)} ETH`],
      ["Reserve cap", `${formatEth(stats.reserveCap)} ETH`],
      [
        "Buys close at",
        stats.graduationThreshold > 0
          ? `${formatEth(stats.graduationThreshold)} ETH in reserve`
          : "never",
      ],
      ["Creator fee", `${formatBps(stats.feeBps)} per leg`],
    ];

    // Only shown when true — a status row that reads "no" on every healthy
    // listing is noise, and these two are the states that change what a reader
    // can do next.
    if (stats.graduated) rows.push(["Status", "Graduated — buys closed, selling open"]);
    if (stats.paused) rows.push(["Status", "Trading halted by the platform emergency stop"]);
    if (!stats.verified) rows.push(["Registry", "Not registered with the configured factory"]);

    return rows;
  }

  if (stats.kind === "legacy") {
    return [
      contractRow,
      ["Symbol", `$${token.symbol}`],
      ["Design", "Fixed-price sale (pre-factory)"],
      ["Total supply", formatAmount(stats.supply || token.supply)],
      ["Buy price", `${formatEth(Number(token.starting_price))} ETH`],
      ["Sell price", stats.buyback ? `${formatEth(stats.buyback.sellPrice)} ETH` : "no buyback"],
      ...(stats.buyback
        ? ([["Buyback reserve", `${formatEth(stats.buyback.reserve)} ETH`]] as [
            string,
            React.ReactNode,
          ][])
        : []),
    ];
  }

  return [
    contractRow,
    ["Symbol", `$${token.symbol}`],
    ["Total supply", formatAmount(token.supply)],
    ["On-chain data", "unreachable"],
  ];
}
