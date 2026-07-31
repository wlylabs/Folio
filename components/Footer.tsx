import Link from "next/link";
import { DEFAULT_CHAIN_SLUG, chainBySlug } from "@/lib/chains";

/**
 * The colophon. Small, but it answers the question a launchpad has to answer
 * before anyone signs anything — which network is this, and is the money real.
 */
export default function Footer() {
  const chain = chainBySlug(DEFAULT_CHAIN_SLUG)?.chain.name ?? DEFAULT_CHAIN_SLUG;

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
        <p className="eyebrow">Folio · Testnet edition · {chain}</p>

        <nav className="footer__links" aria-label="Legal">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
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
