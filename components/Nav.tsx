"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import SettingsMenu from "@/components/SettingsMenu";

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
          {/*
            No "Launch" link here. The front page already makes that offer
            twice — the masthead button and, on an empty edition, the one in
            the feed — and the colophon carries it on every other page. A third
            copy in the masthead was the one nobody was reading.
          */}
          {isConnected && (
            <Link
              href="/profile"
              className="nav-link"
              aria-current={pathname === "/profile" ? "page" : undefined}
            >
              Staff
            </Link>
          )}
          {/* The wallet and the currency both live in here: they are settings,
              not navigation, and the masthead was treating them as both. */}
          <SettingsMenu />
        </div>
      </nav>
    </header>
  );
}
