import type { Metadata } from "next";
import Link from "next/link";

/**
 * What the reader gets instead of the browser's error page.
 *
 * The service worker precaches this on install and serves it for any navigation
 * it cannot reach the network for and has no cached copy of — see public/sw.js.
 * That is the whole reason it is `force-static`: it has to be a page that
 * exists in full before it is needed, with nothing to fetch and nothing to
 * render from a database.
 *
 * It also has to be honest about a launchpad specifically. A reader who lands
 * here has no prices, no balances and no way to sign anything, and the useful
 * thing to say is which of those come back on their own when the connection
 * does.
 */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Offline — Folio",
  description: "Folio needs a connection to quote a price or place a trade.",
  // Nothing here belongs in a search result: it is a fallback for a state, not
  // a page about anything.
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <main id="main" className="shell shell--measure page">
      <article className="legal">
        <header className="legal__head">
          <p className="eyebrow">No connection</p>
          <h1 className="legal__title">This edition didn&rsquo;t arrive</h1>
        </header>

        <div className="prose">
          <p>
            Folio is installed and running — it is the network that is missing.
            The parts of this site that matter are all questions asked of
            somewhere else: a price is quoted by a contract, a balance is read
            from a chain, and a trade is a transaction that has to reach one.
            None of them can be answered from here.
          </p>
          <p>
            Nothing has been lost. Any listing you have already opened is still
            readable from this device, and a launch you were part-way through
            was never sent — a transaction exists only once your wallet signs it
            and the chain accepts it.
          </p>
          <p>
            When you are back on a connection, this page goes away on its own.
          </p>

          <p>
            <Link href="/" className="btn btn--primary">
              Try the front page
            </Link>
          </p>
        </div>
      </article>
    </main>
  );
}
