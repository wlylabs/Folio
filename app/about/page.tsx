import type { Metadata } from "next";
import Link from "next/link";
import { chainLabel, explorerAddressUrl } from "@/lib/chains";
import { FACTORY_DEPLOYMENTS } from "@/lib/contracts/deployment";
import { CONTACT_EMAIL } from "@/lib/contact";
import { formatBps, shortAddress } from "@/lib/types";
import { socialMetadata } from "@/lib/seo";

// Nothing here is read from the database, so it prerenders. The one dynamic
// fact — which factory the app points at — is a committed file, baked in at
// build time along with everything else.
export const dynamic = "force-static";

const DESCRIPTION =
  "What Folio is, how a launch works, and what the network a token is published on means for the money involved.";

export const metadata: Metadata = {
  title: "About Folio",
  description: DESCRIPTION,
  alternates: { canonical: "/about" },
  ...socialMetadata({
    title: "About Folio",
    description: DESCRIPTION,
    path: "/about",
    article: {},
  }),
};

export default function AboutPage() {
  const deployments = FACTORY_DEPLOYMENTS;

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

          <h2>Every launch here is real money</h2>
          <p>
            Folio runs on one network. A launch on{" "}
            <strong>Robinhood Chain</strong> settles in real ETH — the trade is
            final, the fees are real, and a token bought there can lose every
            bit of what it cost. It is not an investment and nobody is
            underwriting it.
          </p>
          <p>
            There is no test network and no practice mode. Folio used to carry
            Base Sepolia alongside Robinhood Chain for rehearsal; that is gone,
            so nothing on this site is a rehearsal. Every listing names its
            network and so does the trade panel before you sign, and the answer
            is always the one that costs real ETH.
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

        {/*
          One block per chain with a factory. Folio runs the same contracts on
          more than one network, and a reader who wants to check the factory
          their token came from needs the address for *their* chain — a single
          "this deployment" row would name whichever one happened to be the
          default and quietly mislead everyone else.
        */}
        <div className="factbox" style={{ marginTop: "var(--sp-7)" }}>
          <div className="factbox__head">
            <span>{deployments.length > 1 ? "Deployments" : "This deployment"}</span>
          </div>

          {deployments.length === 0 && (
            <div className="factbox__row">
              <span>Factory</span>
              <span className="mono">Not configured</span>
            </div>
          )}

          {deployments.map((deployment) => {
            const factoryUrl = explorerAddressUrl(deployment.chain, deployment.factory);
            return (
              <div key={deployment.chain}>
                <div className="factbox__row">
                  <span>Network</span>
                  <span>{chainLabel(deployment.chain)}</span>
                </div>

                <div className="factbox__row">
                  <span>Factory</span>
                  <span className="mono">
                    {factoryUrl ? (
                      <a href={factoryUrl} target="_blank" rel="noopener noreferrer">
                        {shortAddress(deployment.factory)}
                      </a>
                    ) : (
                      shortAddress(deployment.factory)
                    )}
                  </span>
                </div>

                <div className="factbox__row">
                  <span>Creator fee</span>
                  <span className="nums">
                    {formatBps(deployment.defaultConfig.feeBps)} per leg
                  </span>
                </div>
              </div>
            );
          })}
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
