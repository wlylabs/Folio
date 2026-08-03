import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import TradeBar from "@/components/TradeBar";
import TradeHistoryPanel from "@/components/TradeHistoryPanel";
import CreatorFees from "@/components/CreatorFees";
import MigrationPrompt from "@/components/MigrationPrompt";
import SetupNotice from "@/components/SetupNotice";
import Mark from "@/components/Mark";
import CreatorMark from "@/components/CreatorMark";
import FiatValue from "@/components/FiatValue";
import JsonLd from "@/components/JsonLd";
import Addenda from "@/components/Addenda";
import AddendumComposer from "@/components/AddendumComposer";
import { sanitizeArticleHtml } from "@/lib/sanitize";
import { fetchAddenda } from "@/lib/addenda";
import { fetchReadership, readershipLine, READERSHIP_NOTE } from "@/lib/readership";
import { fetchTokenStats } from "@/lib/tokenStats";
import { chainBySlug, chainLabel, explorerAddressUrl } from "@/lib/chains";
import {
  pageTitle,
  socialMetadata,
  tokenArticleJsonLd,
  tokenDescription,
  tokenHeadline,
  tokenPath,
} from "@/lib/seo";
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
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  const token = await getToken(address);
  // An address with no listing behind it. The page itself calls notFound(), and
  // Next renders not-found with a 404 and its own noindex — so this is the
  // belt-and-braces copy for anything that reads metadata without following
  // that path. What it must not do is claim a canonical or a share card.
  if (!token) {
    return { title: pageTitle("Token not found"), robots: { index: false, follow: true } };
  }

  const headline = tokenHeadline(token);
  const description = tokenDescription(token);
  const path = tokenPath(token);

  return {
    title: pageTitle(headline),
    description,
    // Addresses are stored lowercased but a link may carry checksum casing, so
    // two URLs can serve the same listing. The canonical names one of them.
    alternates: { canonical: path },
    authors: [{ name: shortAddress(token.creator_wallet) }],
    ...socialMetadata({
      title: headline,
      description,
      path,
      // The token's own avatar when it has one; the Folio card otherwise.
      image: token.avatar_url,
      imageAlt: `${token.name} avatar`,
      article: {
        publishedTime: token.created_at,
        authors: [shortAddress(token.creator_wallet)],
      },
    }),
  };
}

export default async function TokenPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  if (!isSupabaseConfigured) return <SetupNotice />;

  const { address } = await params;
  const token = await getToken(address);
  if (!token) return notFound();

  /*
   * Three reads with nothing to say to each other, so none of them waits on
   * another: the contract's live figures, whatever the author added after
   * publishing, and how many addresses have actually bought.
   *
   * Both of the new ones answer with "nothing" rather than throwing — an
   * article whose additions or whose readership could not be read is still an
   * article, and a listing page that 500s over a footnote would be a worse
   * failure than the one it is reporting.
   */
  const [stats, addenda, readership] = await Promise.all([
    fetchTokenStats(token),
    fetchAddenda(token),
    fetchReadership(token),
  ]);
  const explorer = explorerAddressUrl(token.chain, token.contract_address);

  return (
    /*
      One column, read top to bottom: headline, article, then the decision the
      article is arguing for. The trade panel used to sit in a rail beside the
      headline, which put a buy button in front of a reader who had not yet read
      a word of the piece it belongs to.
    */
    <main id="main" className="shell shell--measure page article">
      {/*
        Server-rendered, like everything else on this page: the listing is a
        piece of writing with a date and a byline, and this is the machine-
        readable statement of that. It is what lets a token page compete as an
        article rather than as one more address.
      */}
      <JsonLd
        data={tokenArticleJsonLd(token, {
          authorUrl: explorerAddressUrl(token.chain, token.creator_wallet),
          // The article body cannot change; what can is how much of the piece
          // there is. The last addition is the honest dateModified.
          modified: addenda.at(-1)?.created_at ?? null,
        })}
      />

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
          <CreatorMark
            wallet={token.creator_wallet}
            verified={token.creator_verified}
            href={explorerAddressUrl(token.chain, token.creator_wallet)}
          />
          <span aria-hidden="true">·</span>
          <span>{formatDate(token.created_at)}</span>

          {/*
            The way past the article for someone who came back to trade rather
            than to read. Putting the panel after the piece is right for a first
            visit and tedious on the fifth, and one anchor settles both.
          */}
          <a className="article__jump" href="#trade">
            Buy or sell
          </a>
        </div>

        {/*
          Where a blog would print a view counter, and the reason this one is
          worth printing: every address in it paid gas on a network settling in
          real ETH to be counted. A view is a request; this is a decision.

          Absent, rather than zero, wherever the trade log has not been recorded
          — see lib/readership.ts. "Nobody has bought this yet" is a fact about
          a launch; the same sentence printed by a deployment that is not
          counting would be a lie about one.
        */}
        {readership && (
          <p className="article__readership" title={READERSHIP_NOTE}>
            {readershipLine(readership)}
          </p>
        )}
      </div>

      <article
        className="article__body prose"
        // Sanitized server-side: article_body is written through the public
        // anon key, so it is untrusted input.
        dangerouslySetInnerHTML={{ __html: sanitizeArticleHtml(token.article_body) }}
      />

      {/*
        What the author added after publishing, and — for the author — the box
        that adds one.

        Between the article and the trade panel on purpose. A correction the
        reader meets after the buy button is a correction that arrived too late
        to be worth publishing, and the whole reason this exists rather than an
        edit button is that on Folio somebody traded on the words.
      */}
      <Addenda addenda={addenda} />
      <AddendumComposer token={token} />

      <section id="trade" className="article__decision" aria-labelledby="trade-heading">
        <h2 id="trade-heading" className="decision__title">
          Buy or sell ${token.symbol}
        </h2>

        {/*
          The figures that actually bear on the decision, and only those: what a
          token costs, what the whole thing is worth, how much of it is already
          out. The rest of the contract's data is reference, and waits folded
          below the panel rather than standing between the article and the
          button.
        */}
        <div className="glance">
          {glanceCells(token, stats).map((cell) => (
            <div key={cell.label} className="glance__cell">
              <span className="glance__label">{cell.label}</span>
              <span className="glance__value">{cell.value}</span>
              {cell.meter !== undefined && (
                <div
                  className="meter glance__meter"
                  role="progressbar"
                  aria-label="Share of supply issued"
                  aria-valuenow={Math.round(cell.meter)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div className="meter__fill" style={{ width: `${cell.meter}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>

        {/*
          Reserve health is the sell-back guarantee stated as one number: 10000
          bps means the reserve exactly covers every token in circulation. Below
          that would mean the curve owes more than it holds, which the contract's
          maths does not permit — so it is worth saying out loud when it holds,
          and worth alarming on if it ever doesn't. It sits above the button
          because it is the one line that should change what gets pressed.
        */}
        {stats.kind === "curve" && (
          <p className="field__hint">
            {stats.reserveHealthBps >= 10_000
              ? `Reserve covers ${formatPercent(stats.reserveHealthBps / 100)} of what the curve owes holders — every token in circulation can be sold back.`
              : `Reserve covers only ${formatPercent(
                  stats.reserveHealthBps / 100
                )} of what the curve owes holders. Trade with care.`}
          </p>
        )}

        <TradeBar token={token} stats={stats} />

        {/*
          The step after the curve, where a launch has graduated and the
          deployment named a migrator. It renders nothing in every other case,
          which is most of them — see the component. Placed directly under the
          panel because it is the same decision surface: the trade bar has just
          told the reader buying is closed, and this is what closed means next.
        */}
        {stats.kind === "curve" && <MigrationPrompt token={token} stats={stats} />}

        {/*
          Everything the contract says, folded. Shut by default because it is
          checking material rather than reading material — the address, the caps,
          the fee — and open in one press for anyone who wants to verify the
          claim the panel above is making.
        */}
        <details className="factbox factbox--fold">
          <summary className="factbox__head">
            <span>Contract data</span>
            {/*
              Read from the token's own chain, never a constant. Every network
              Folio supports settles in real ETH, so a recognised chain is a
              mainnet — but an unrecognised one must not inherit that word. Rows
              launched on the retired Base Sepolia testnet are still in the
              database and their slug no longer resolves; calling those
              "Mainnet" would be the one error on this page that costs a reader
              money, so they say what is actually true instead.
            */}
            <span>{chainBySlug(token.chain) ? "Mainnet" : "Unsupported network"}</span>
          </summary>

          <div className="factbox__rows">
            {factRows(token, stats, explorer).map(([label, value]) => (
              <div key={label} className="factbox__row">
                <span className="factbox__label">{label}</span>
                <span className="factbox__value">{value}</span>
              </div>
            ))}
          </div>
        </details>
      </section>

      {/*
        Below the decision rather than above it: the chart is the record of what
        other people decided, which is context for a trade and not the case for
        one. It also loads on its own schedule, and nothing above it should be
        waiting on that.
      */}
      {stats.kind === "curve" && (
        <div className="article__chart">
          <TradeHistoryPanel token={token} />
        </div>
      )}

      {/*
        Renders for the creator and nobody else, and decides that from
        `creator()` on the contract rather than the database's byline — one is a
        fact, the other is a claim, and this one moves money.
      */}
      {stats.kind === "curve" && (
        <div className="article__owner">
          <CreatorFees token={token} stats={stats} />
        </div>
      )}
    </main>
  );
}

/**
 * An ETH figure with its worth in the reader's currency underneath.
 *
 * The conversion is a client component inside an otherwise server-rendered
 * table: the ETH is in the HTML the server sends, and the estimate appears
 * beside it once the rate lands — or never, if the price feed is unreachable.
 */
function Eth({ value, suffix = "" }: { value: number; suffix?: string }) {
  return (
    <>
      {formatEth(value)} ETH{suffix}
      <FiatValue eth={value} block />
    </>
  );
}

/** One tile above the trade panel. `meter` draws a bar under the value. */
type Glance = { label: string; value: React.ReactNode; meter?: number };

/**
 * The three figures a reader is deciding on, lifted out of the contract table.
 *
 * The table itself is complete and folded away; this is the part of it that
 * belongs next to the button. Which three they are depends on what is deployed
 * at the address — a fixed-price sale has no marginal price to quote, and a
 * listing with nothing readable behind it should say so here rather than print
 * stored numbers as though they were live.
 */
function glanceCells(token: Token, stats: TokenStats): Glance[] {
  // The share of supply already issued is the one figure a reader scans for,
  // and a bar says it faster than a percentage does.
  const issued: Glance = {
    label: "Issued",
    value: formatPercent(stats.percentSold),
    meter: stats.percentSold,
  };

  if (stats.kind === "curve") {
    return [
      { label: "Price now", value: <Eth value={stats.price} /> },
      { label: "Market cap", value: <Eth value={stats.marketCap} /> },
      issued,
    ];
  }

  if (stats.kind === "legacy") {
    return [
      { label: "Buy price", value: <Eth value={Number(token.starting_price)} /> },
      {
        label: "Sell price",
        value: stats.buyback ? <Eth value={stats.buyback.sellPrice} /> : "no buyback",
      },
      issued,
    ];
  }

  return [
    { label: "Symbol", value: `$${token.symbol}` },
    { label: "Total supply", value: formatAmount(token.supply) },
    { label: "On-chain data", value: "unreachable" },
  ];
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
      ["Price now", <Eth key="price" value={stats.price} />],
      ["Market cap", <Eth key="cap" value={stats.marketCap} />],
      ["Reserve", <Eth key="reserve" value={stats.reserve} />],
      ["Reserve cap", <Eth key="reserve-cap" value={stats.reserveCap} />],
      [
        "Buys close at",
        stats.graduationThreshold > 0 ? (
          <Eth key="threshold" value={stats.graduationThreshold} suffix=" in reserve" />
        ) : (
          "never"
        ),
      ],
      ["Creator fee", `${formatBps(stats.feeBps)} per leg`],
    ];

    // Only shown when true — a status row that reads "no" on every healthy
    // listing is noise, and these two are the states that change what a reader
    // can do next.
    // Migration first: it is the stronger state, and the graduated line promises
    // that selling stays open, which stops being true the moment the reserve
    // leaves for the pool.
    if (stats.migrated) {
      rows.push(["Status", "Migrated to a Uniswap v4 pool — the curve is closed both ways"]);
      if (stats.poolPrice !== null) {
        rows.push(["Pool price", <Eth key="poolprice" value={stats.poolPrice} />]);
      }
      // The explorer link is optional the same way the contract row's is: a
      // chain without one still gets the address, just not as a link.
      const migrator = stats.migrator;
      const migratorUrl = migrator ? explorerAddressUrl(token.chain, migrator) : null;
      if (migrator) {
        rows.push([
          "Pool held by",
          migratorUrl ? (
            <a key="migrator" href={migratorUrl} target="_blank" rel="noopener noreferrer">
              {shortAddress(migrator)}
            </a>
          ) : (
            shortAddress(migrator)
          ),
        ]);
      }
    } else if (stats.graduated) {
      rows.push(["Status", "Graduated — buys closed, selling open"]);
    }
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
      ["Buy price", <Eth key="buy" value={Number(token.starting_price)} />],
      [
        "Sell price",
        stats.buyback ? <Eth key="sell" value={stats.buyback.sellPrice} /> : "no buyback",
      ],
      ...(stats.buyback
        ? ([
            ["Buyback reserve", <Eth key="buyback" value={stats.buyback.reserve} />],
          ] as [string, React.ReactNode][])
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
