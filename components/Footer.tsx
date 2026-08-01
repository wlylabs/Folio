import Link from "next/link";
import { DEFAULT_CHAIN_SLUG, chainBySlug } from "@/lib/chains";
import { FACTORY_DEPLOYMENTS } from "@/lib/contracts/deployment";
import { CONTACT_EMAIL } from "@/lib/contact";

/**
 * The colophon. Small, but it answers the question a launchpad has to answer
 * before anyone signs anything — which network is this, and is the money real.
 *
 * It names the network, which with one network live is a complete answer: every
 * listing is on Robinhood Chain and the ETH is real. The count branch below
 * survives for the same reason SUPPORTED_CHAINS is still a list — naming one of
 * several networks on a page showing a token from another would be a wrong
 * answer to exactly the question this line exists to answer.
 *
 * The line used to read "Testnet edition", and later carried a `· testnet`
 * marker for the networks that deserved it. Neither is here now: nothing Folio
 * supports is a test network, and a marker that can never appear is a claim the
 * reader has to rule out rather than read.
 */
export default function Footer() {
  const entry = chainBySlug(FACTORY_DEPLOYMENTS[0]?.chain ?? DEFAULT_CHAIN_SLUG);
  const chain =
    FACTORY_DEPLOYMENTS.length > 1
      ? `${FACTORY_DEPLOYMENTS.length} networks`
      : (entry?.chain.name ?? DEFAULT_CHAIN_SLUG);

  return (
    <footer
      // No top margin: every page already ends on `.page`'s bottom padding,
      // and stacking the two opened a dead band above the rule.
      style={{
        borderTop: "1px solid var(--rule)",
        paddingBlock: "var(--sp-5)",
      }}
    >
      <div
        className="shell"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--sp-3)",
        }}
      >
        <p className="eyebrow">Folio · {chain}</p>

        <nav className="footer__links" aria-label="Site">
          <Link href="/about">About</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          {/* Plain <a>: next/link is for routes, and this leaves the site. */}
          <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
        </nav>

        <p
          className="font-ui"
          style={{ fontSize: "var(--fs-micro)", color: "var(--ink-muted)" }}
        >
          Tokens here carry no value.{" "}
          <Link href="/create">Launch one</Link>.
        </p>
      </div>
    </footer>
  );
}
