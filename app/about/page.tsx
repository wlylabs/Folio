import type { Metadata } from "next";
import Link from "next/link";
import { chainLabel, DEFAULT_CHAIN_SLUG, explorerAddressUrl } from "@/lib/chains";
import { FACTORY_DEPLOYMENT } from "@/lib/contracts/deployment";
import { CONTACT_EMAIL } from "@/lib/contact";
import { formatBps, shortAddress } from "@/lib/types";

// Nothing here is read from the database, so it prerenders. The one dynamic
// fact — which factory the app points at — is a committed file, baked in at
// build time along with everything else.
export const dynamic = "force-static";

const DESCRIPTION =
  "What Folio is, how a launch works, and what a testnet edition means for the tokens published on it.";

export const metadata: Metadata = {
  title: "About Folio",
  description: DESCRIPTION,
  alternates: { canonical: "/about" },
  openGraph: {
    title: "About Folio",
    description: DESCRIPTION,
    url: "/about",
    type: "article",
  },
};

export default function AboutPage() {
  const deployment = FACTORY_DEPLOYMENT;
  const factoryUrl = deployment
    ? explorerAddressUrl(deployment.chain, deployment.factory)
    : null;

  return (
    <main id="main" className="shell shell--measure page">
      <article className="legal">
        <header className="legal__head">
          <p className="eyebrow">About</p>
          <h1 className="legal__title">Every token, told as a story</h1>
        </header>

        <div className="prose">
          <p>
            Folio is a launchpad where the listing <em>is</em> the article.
            There is no description field to fill in beside a ticker: you write
            the piece, publish it, and the token it describes is minted onto a
            bonding curve that quotes both sides of the trade from the page
            itself.
          </p>

          <h2>What a launch actually is</h2>
          <p>
            One transaction to the factory contract clones an ERC20 that is
            also its own market maker. Name, symbol, supply, curve terms and
            creator fee are frozen at that moment — nothing on this site can
            rewrite them afterwards, and no admin key here can either.
          </p>
          <p>
            Readers buy from the curve and sell straight back to the reserve it
            holds. There is no pool to seed, no counterparty to find and no
            listing fee, so a launch costs its creator nothing but gas. Every
            price you see on an article is quoted by the contract as you read
            it, not cached from a market somewhere else.
          </p>

          <h2>This is a testnet edition</h2>
          <p>
            Every launch settles in testnet ETH from a faucet. The tokens carry
            no value, they are not an investment, and the network they live on
            can be reset out from under them. Treat everything here as a
            rehearsal.
          </p>
          <p>
            One limitation is worth stating plainly: a byline is a claim, not a
            proof. Folio records the wallet that published an article but cannot
            yet verify that wallet signed anything, so the author of a listing
            is unconfirmed until wallet sign-in ships.
          </p>

          <h2>What Folio stores</h2>
          <p>
            The article, its image and the launch metadata live in a database;
            the token, its supply and its reserve live on-chain and are the
            authority on anything financial. Your currency choice and your
            answer to the cookie banner stay in your own browser — both are in
            the settings panel in the masthead, and both can be changed at any
            time. The{" "}
            <Link href="/privacy">privacy policy</Link> is the long version.
          </p>

          <h2>The fine print</h2>
          <p>
            The <Link href="/terms">terms</Link> and{" "}
            <Link href="/privacy">privacy policy</Link> are drafts pending legal
            review, and they say so at the top of each page. Questions about
            either go to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
        </div>

        <div className="factbox" style={{ marginTop: "var(--sp-7)" }}>
          <div className="factbox__head">
            <span>This deployment</span>
          </div>

          <div className="factbox__row">
            <span>Network</span>
            <span>{chainLabel(deployment?.chain ?? DEFAULT_CHAIN_SLUG)}</span>
          </div>

          <div className="factbox__row">
            <span>Factory</span>
            <span className="mono">
              {!deployment ? (
                "Not configured"
              ) : factoryUrl ? (
                <a href={factoryUrl} target="_blank" rel="noopener noreferrer">
                  {shortAddress(deployment.factory)}
                </a>
              ) : (
                shortAddress(deployment.factory)
              )}
            </span>
          </div>

          {deployment && (
            <div className="factbox__row">
              <span>Creator fee</span>
              <span className="nums">
                {formatBps(deployment.defaultConfig.feeBps)} per leg
              </span>
            </div>
          )}
        </div>

        <p style={{ marginTop: "var(--sp-6)" }}>
          <Link href="/create" className="btn btn--primary">
            Launch a token
          </Link>
        </p>
      </article>
    </main>
  );
}
