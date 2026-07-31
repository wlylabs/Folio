"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "wagmi";
import SettingsMenu from "@/components/SettingsMenu";
import Logo from "@/components/Logo";
import {
  LAUNCHPAD_PATH,
  POSTFOLIO_NAME,
  POSTFOLIO_PATH,
  modeForPath,
} from "@/lib/postfolio";

export default function Nav() {
  const { isConnected } = useAccount();
  const pathname = usePathname() ?? LAUNCHPAD_PATH;

  // Which view you are in decides what the wordmark says and where it goes.
  // Inside Postfolio the masthead is Postfolio's — a "FOLIO" wordmark that
  // returns to the launchpad would undo the switch every time a reader reached
  // for the way back up.
  const mode = modeForPath(pathname);
  const home = mode === "postfolio" ? POSTFOLIO_PATH : LAUNCHPAD_PATH;

  // Each view's front page opens with its own full masthead, so the nav would
  // only be repeating the wordmark a few pixels above it.
  const showWordmark = pathname !== home;

  return (
    <header className="navbar">
      <nav className="shell navbar__inner" aria-label="Primary">
        {showWordmark ? (
          // The masthead, shrunk down: same face and weight as the front page
          // so the two read as one wordmark rather than two.
          <Link
            href={home}
            aria-label={mode === "postfolio" ? `${POSTFOLIO_NAME} — home` : "Folio — home"}
            className="wordmark"
          >
            <Logo className="wordmark__mark" />
            <span className="wordmark__text">
              {mode === "postfolio" ? POSTFOLIO_NAME.toUpperCase() : "FOLIO"}
            </span>
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

            The view switch is not here either: it moved into the settings
            panel. It is thrown once and then left alone for a whole session,
            which is not enough traffic to hold a permanent frame in a bar this
            narrow — and standing next to the wordmark it read as navigation to
            two more pages rather than as the one control that decides which
            side of the site you are on.
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
