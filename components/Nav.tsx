"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useAccount } from "wagmi";
import SettingsMenu from "@/components/SettingsMenu";
import Logo from "@/components/Logo";
import { rememberWalletHint } from "@/lib/walletHint";

export default function Nav() {
  const { isConnected, status } = useAccount();
  const pathname = usePathname() ?? "/";

  // The front page opens with its own full masthead, so the nav would only be
  // repeating the wordmark a few pixels above it.
  const showWordmark = pathname !== "/";

  /**
   * Whether wagmi has finished making up its mind.
   *
   * `reconnecting` is the state a reload spends its first few hundred
   * milliseconds in while a stored session is revived, and it is the whole
   * reason the bar used to jump: the answer arrives after the page is on
   * screen. Until it does, the masthead leaves the link's space alone rather
   * than adding it — the space itself is already being held, from a hint the
   * boot script read before the first paint (lib/walletHint.ts).
   */
  const settled = status !== "connecting" && status !== "reconnecting";

  // Written every time the answer settles, so the next reload starts from the
  // truth: held space for a reader who is connected, none for one who is not.
  useEffect(() => {
    if (settled) rememberWalletHint(isConnected);
  }, [settled, isConnected]);

  return (
    <header className="navbar">
      <nav className="shell navbar__inner" aria-label="Primary">
        {showWordmark ? (
          // The masthead, shrunk down: same face and weight as the front page
          // so the two read as one wordmark rather than two.
          <Link href="/" aria-label="Folio — home" className="wordmark">
            <Logo className="wordmark__mark" />
            <span className="wordmark__text">FOLIO</span>
          </Link>
        ) : (
          // Holds the left end of the bar so the switch and the settings stay
          // where they were on the page that hides its wordmark.
          <span aria-hidden="true" />
        )}

        <div className="navbar__links">
          {/*
            No "Launch" link here. The front page already makes that offer
            twice — the masthead button and, on an empty edition, the one in
            the feed — and the colophon carries it on every other page. A third
            copy in the masthead was the one nobody was reading.
          */}
          {isConnected ? (
            <Link
              href="/profile"
              className="nav-link"
              aria-current={pathname === "/profile" ? "page" : undefined}
            >
              Staff
            </Link>
          ) : (
            // The same word, drawn invisibly, so the space held is exactly the
            // space the link will take — a guessed width would trade a jump for
            // a smaller jump. The stylesheet collapses this to nothing unless
            // <html> carries the hint, and it is inert to a screen reader:
            // there is no link here yet, and announcing one would be a lie
            // about a connection that may never come back.
            <span className="nav-link nav-link--held" aria-hidden="true">
              Staff
            </span>
          )}
          {/* The wallet and the currency both live in here: they are settings,
              not navigation, and the masthead was treating them as both. */}
          <SettingsMenu />
        </div>
      </nav>
    </header>
  );
}
