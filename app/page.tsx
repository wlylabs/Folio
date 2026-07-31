import Link from "next/link";
import type { Metadata } from "next";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import SetupNotice from "@/components/SetupNotice";
import JsonLd from "@/components/JsonLd";
import Mark from "@/components/Mark";
import Logo from "@/components/Logo";
import FiatValue from "@/components/FiatValue";
import { articleExcerpt } from "@/lib/sanitize";
import { listPosts, postPath, topicLabel, type PostCard } from "@/lib/posts";
import { chainLabel, DEFAULT_CHAIN_SLUG } from "@/lib/chains";
import {
  pageTitle,
  siteJsonLd,
  socialMetadata,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
} from "@/lib/seo";
import { FACTORY_DEPLOYMENT } from "@/lib/contracts/deployment";
import {
  formatAmount,
  formatBps,
  formatDateShort,
  formatEth,
  type Token,
} from "@/lib/types";

export const revalidate = 0;

/**
 * The front page states the value proposition rather than the product
 * category: what makes a Folio listing different is that it is written, and a
 * search result that leads with "launchpad" says nothing a hundred others
 * don't. No claim here touches price or return.
 */
export const metadata: Metadata = {
  title: pageTitle(SITE_TAGLINE),
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  ...socialMetadata({
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    path: "/",
  }),
};

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

  // Two feeds, read together. Neither can fail the page — both helpers swallow
  // their errors — so a deployment that has not created the `posts` table yet
  // renders the launch feed exactly as it did before.
  const [tokens, posts] = await Promise.all([getTokens(), listPosts(6)]);

  return (
    <main id="main">
      <JsonLd data={siteJsonLd()} />

      <header className="shell">
        <div className="masthead">
          {/* An emblem above the nameplate, the way a printed front page
              carries one. The nav pairs the two side by side instead — there
              is no vertical room up there for a stacked lockup. */}
          <Logo className="masthead__mark" />
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
            {/* The other half of the edition, and it is a read rather than a
                write: the desk's articles are published by staff, and what a
                visitor does with them is read them. The offer beside "launch"
                is therefore the archive, not a second form — the launchpad is
                the only door onto the site, which is what makes it worth
                putting first. */}
            <Link href="/read" className="btn btn--outline">
              Read the desk
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

        {/*
          The desk's own writing, below the listings rather than mixed into
          them. They are both articles, but a launch card carries a supply and a
          ticker a reader can act on, and interleaving the two would have made
          every card ambiguous about whether there is a token behind it.
        */}
        {posts.length > 0 && (
          <section className="pitch" aria-labelledby="articles">
            <div className="section-head">
              <h2 className="eyebrow" id="articles">
                From the article desk
              </h2>
              <Link href="/read" className="eyebrow">
                All articles
              </Link>
            </div>

            <div className="feed">
              {posts.map((post) => (
                <PostCardLink key={post.id} post={post} />
              ))}
            </div>
          </section>
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

  const virtualReserve = Number(config.virtualEthReserve) / 1e18;
  const reserveCeiling = Number(config.maxReserveCap) / 1e18;
  const threshold = Number(config.graduationThreshold) / 1e18;

  // "Starting reserve", not "market cap": this is the virtual ETH the curve
  // prices from, and calling it a cap would invite a comparison with platforms
  // where that word means price times supply.
  const terms: [string, React.ReactNode][] = [
    [
      "Starting reserve",
      <>
        {formatEth(virtualReserve)} ETH virtual
        <FiatValue eth={virtualReserve} block />
      </>,
    ],
    [
      "Reserve ceiling",
      <>
        {formatEth(reserveCeiling)} ETH
        <FiatValue eth={reserveCeiling} block />
      </>,
    ],
    [
      "Buys close at",
      config.graduationThreshold > 0n ? (
        <>
          {formatEth(threshold)} ETH
          <FiatValue eth={threshold} block />
        </>
      ) : (
        "never"
      ),
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

/**
 * An article card. Deliberately the same shape as a listing card and never the
 * lead — the front page leads with a launch, and an article that borrowed the
 * lead treatment would read as one.
 */
function PostCardLink({ post }: { post: PostCard }) {
  return (
    <Link href={postPath(post)} className="card">
      <div className="card__meta">
        <span className="card__kicker">{topicLabel(post.topic)} · Article</span>
      </div>

      <h3 className="card__title">{post.title}</h3>

      {post.excerpt && <p className="card__excerpt">{post.excerpt}</p>}

      <div className="card__foot">
        <span>No token</span>
        <span className="nums">{formatDateShort(post.created_at)}</span>
      </div>
    </Link>
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
