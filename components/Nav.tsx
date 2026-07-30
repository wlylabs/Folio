"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import WalletButton from "@/components/WalletButton";

export default function Nav() {
  const { isConnected } = useAccount();
  // The front page opens with the full masthead, so the nav would only be
  // repeating the wordmark a few pixels above it.
  const showWordmark = usePathname() !== "/";

  return (
    <div
      className="font-ui"
      style={{
        maxWidth: 640,
        margin: "0 auto",
        display: "flex",
        justifyContent: showWordmark ? "space-between" : "flex-end",
        alignItems: "center",
        gap: 12,
        padding: "10px 20px",
        borderBottom: "1px solid var(--rule)",
        fontSize: 11,
      }}
    >
      {showWordmark && (
        // The masthead, shrunk down: same face and weight as the front page so
        // the two read as one wordmark rather than two.
        <Link
          href="/"
          aria-label="Folio — home"
          className="font-display wordmark"
          style={{ fontWeight: 900, fontSize: 15, letterSpacing: 0.5 }}
        >
          FOLIO
        </Link>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Link href="/create" style={{ color: "var(--ink-soft)" }}>
          Launch
        </Link>
        {isConnected && (
          // The wallet chip carries the address now, so this links by name
          // instead of repeating it.
          <Link href="/profile" style={{ color: "var(--ink-soft)" }}>
            Staff
          </Link>
        )}
        <WalletButton variant="nav" />
      </div>
    </div>
  );
}
