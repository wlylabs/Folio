import Link from "next/link";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import SetupNotice from "@/components/SetupNotice";
import Mark from "@/components/Mark";
import { articleExcerpt } from "@/lib/sanitize";
import { chainLabel, DEFAULT_CHAIN_SLUG } from "@/lib/chains";
import { FACTORY_DEPLOYMENT } from "@/lib/contracts/deployment";
import {
  formatAmount,
  formatBps,
  formatDateShort,
  formatEth,
  type Token,
} from "@/lib/types";

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
          <p className="masthead__lede">
            A launchpad where the listing is the article. Write the piece,
            publish it, and the token it describes is minted onto a bonding
            curve that quotes both sides of the trade from the page itself.
          </p>
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

      {/*
        The feed leads, because a publication's front page is its publications.
        Everything below it explains the thing — which is what a reader arriving
        on an empty edition needs, and what a reader arriving on a full one
        scrolls past.
      */}
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
            <p style={{ marginBottom: "var(--sp-2)" }}>
              No launches are published on {chainLabel(DEFAULT_CHAIN_SLUG)} yet.
            </p>
            <p
              className="font-ui"
              style={{
                fontSize: "var(--fs-small)",
                marginBottom: "var(--sp-5)",
              }}
            >
              A launch is one article and one transaction. Testnet ETH from a
              faucet covers the gas.
            </p>
            <Link href="/create" className="btn btn--primary">
              Write the first one
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

        <section className="pitch" aria-labelledby="how">
          <div className="section-head">
            <h2 className="eyebrow" id="how">
              How a launch works
            </h2>
          </div>

          <ol className="steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className="step">
                <span className="step__num nums" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="step__title">{step.title}</h3>
                <p className="step__body">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <CurveTerms />

        <section className="pitch" aria-labelledby="caveats">
          <div className="section-head">
            <h2 className="eyebrow" id="caveats">
              Before you trade
            </h2>
          </div>

          <div className="notice">
            <p className="notice__title">This is a testnet edition.</p>
            <p style={{ margin: "0 0 var(--sp-3)" }}>
              Every launch here settles in testnet ETH from a faucet. The tokens
              carry no value and are not an investment, and the network can be
              reset out from under them.
            </p>
            <p style={{ margin: "0 0 var(--sp-3)" }}>
              A byline is a claim, not a proof. Folio records the wallet that
              published an article but cannot yet verify it signed anything, so
              treat the author of a listing as unconfirmed until wallet
              sign-in ships.
            </p>
            <p style={{ margin: 0 }}>
              The <Link href="/terms">terms</Link> and{" "}
              <Link href="/privacy">privacy policy</Link> are drafts pending
              legal review.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

const STEPS = [
  {
    title: "Write the piece",
    body:
      "The launch form is an editor, not a ticker generator. A headline, a body, an image if the token has a face. What you write is the listing — there is no separate description field, because the article is the description.",
  },
  {
    title: "Publish it as a token",
    body:
      "One transaction to the factory clones an ERC20 that is also its own market maker. Name, symbol, supply, curve terms and creator fee are frozen at that moment; nothing here can rewrite them afterwards.",
  },
  {
    title: "Readers trade from the article",
    body:
      "Every price on the page is quoted by the contract as you read it. Holders buy from the curve and sell straight back to the reserve it holds — no pool to seed, no counterparty to find, no listing fee.",
  },
];

/**
 * The terms the factory hands the next launch, read from the committed
 * deployment record rather than written into the copy — a re-deploy with
 * different terms must not leave the front page quoting the old ones.
 */
function CurveTerms() {
  const config = FACTORY_DEPLOYMENT?.defaultConfig;
  if (!config) return null;

  const terms: [string, string][] = [
    ["Opening curve", `${formatEth(Number(config.virtualEthReserve) / 1e18)} ETH virtual`],
    ["Reserve ceiling", `${formatEth(Number(config.maxReserveCap) / 1e18)} ETH`],
    [
      "Buys close at",
      config.graduationThreshold > 0n
        ? `${formatEth(Number(config.graduationThreshold) / 1e18)} ETH`
        : "never",
    ],
    ["Creator fee", `${formatBps(config.feeBps)} per leg`],
  ];

  return (
    <section className="pitch" aria-labelledby="terms">
      <div className="section-head">
        <h2 className="eyebrow" id="terms">
          What the next launch opens on
        </h2>
        <span className="eyebrow">{chainLabel(FACTORY_DEPLOYMENT?.chain)}</span>
      </div>

      <div className="stats">
        {terms.map(([label, value]) => (
          <div key={label} className="stat">
            <div className="stat__label">{label}</div>
            <div className="stat__value">{value}</div>
          </div>
        ))}
      </div>

      <p className="pitch__note">
        The virtual reserve sets the opening price — it is priced in, not paid
        in, so a launch costs its creator nothing but gas. The ceiling is the
        most real ETH a curve will ever hold, which makes it the blast radius of
        any single launch. Each token keeps its own frozen copy of these terms;
        these are the ones the factory would hand out today.
      </p>
    </section>
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
