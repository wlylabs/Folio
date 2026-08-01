import Link from "next/link";
import { DEFAULT_CHAIN_SLUG, chainBySlug } from "@/lib/chains";
import { FACTORY_DEPLOYMENTS } from "@/lib/contracts/deployment";
import { CONTACT_EMAIL } from "@/lib/contact";

/**
 * The colophon. Small, but it answers the question a launchpad has to answer
 * before anyone signs anything — which network is this, and is the money real.
 *
 * With more than one network live it names the count rather than one of them:
 * "Base Sepolia" on a page showing a Robinhood token would be a wrong answer to
 * exactly the question this line exists to answer. The token page names its own
 * chain — and says whether that chain is a testnet — and /about lists them all.
 *
 * The line used to read "Testnet edition", which was the answer to the second
 * half of that question while every supported network was a testnet. It is not
 * any more, so the network's own name carries it, marked when it is a test
 * network and left plain when the ETH is real.
 */
export default function Footer() {
  const entry = chainBySlug(FACTORY_DEPLOYMENTS[0]?.chain ?? DEFAULT_CHAIN_SLUG);
  const chain =
    FACTORY_DEPLOYMENTS.length > 1
      ? `${FACTORY_DEPLOYMENTS.length} networks`
      : entry
        ? `${entry.chain.name}${entry.chain.testnet ? " · testnet" : ""}`
        : DEFAULT_CHAIN_SLUG;

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
