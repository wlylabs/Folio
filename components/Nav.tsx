"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import WalletButton from "@/components/WalletButton";

export default function Nav() {
  const { isConnected } = useAccount();
  const pathname = usePathname();
  // The front page opens with the full masthead, so the nav would only be
  // repeating the wordmark a few pixels above it.
  const showWordmark = pathname !== "/";

  return (
    <header className="navbar">
      <nav className="shell navbar__inner" aria-label="Primary">
        {showWordmark && (
          // The masthead, shrunk down: same face and weight as the front page
          // so the two read as one wordmark rather than two.
          <Link href="/" aria-label="Folio — home" className="wordmark">
            FOLIO
          </Link>
        )}

        <div className="navbar__links">
          <Link
            href="/create"
            className="nav-link"
            aria-current={pathname === "/create" ? "page" : undefined}
          >
            Launch
          </Link>
          {isConnected && (
            // The wallet chip carries the address now, so this links by name
            // instead of repeating it.
            <Link
              href="/profile"
              className="nav-link"
              aria-current={pathname === "/profile" ? "page" : undefined}
            >
              Staff
            </Link>
          )}
          <WalletButton variant="nav" />
        </div>
      </nav>
    </header>
  );
}
