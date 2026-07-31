"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LAUNCHPAD_NAME,
  LAUNCHPAD_PATH,
  POSTFOLIO_NAME,
  POSTFOLIO_PATH,
  modeForPath,
} from "@/lib/postfolio";

/**
 * The switch between Folio's two views.
 *
 * Two links in one frame rather than a toggle that remembers a preference: the
 * views are two places, not two settings, and a control that changes what the
 * current page looks like is a different promise from one that takes you
 * somewhere else. Rendering them as links also means the launchpad and
 * Postfolio are each one keyboard tab and one crawl away from the other, which
 * a stateful toggle would have cost.
 *
 * It lives in the settings panel, which is on every page — the whole point of a
 * second view is being able to leave the first one from wherever you are, and
 * one press on Settings is a cheap enough toll for a switch thrown once a
 * session. In the panel it stretches to the full width in two equal halves, so
 * the frame reads as one control with a side selected rather than as a pair of
 * links that happen to be touching.
 */
export default function ModeSwitch() {
  const pathname = usePathname() ?? LAUNCHPAD_PATH;
  const mode = modeForPath(pathname);

  return (
    <div className="mode-switch" role="group" aria-label="Folio view">
      <Link
        href={LAUNCHPAD_PATH}
        className="mode-switch__opt"
        // `aria-current="page"` is the honest attribute only when the link
        // points at the page you are on. Anywhere else in a view — a token, the
        // launch form — the option is still the selected one, so it is marked
        // as pressed-looking via data-on and left un-current for the reader.
        aria-current={pathname === LAUNCHPAD_PATH ? "page" : undefined}
        data-on={mode === "launchpad" ? "true" : undefined}
      >
        {LAUNCHPAD_NAME}
      </Link>
      <Link
        href={POSTFOLIO_PATH}
        className="mode-switch__opt"
        aria-current={pathname === POSTFOLIO_PATH ? "page" : undefined}
        data-on={mode === "postfolio" ? "true" : undefined}
      >
        {POSTFOLIO_NAME}
      </Link>
    </div>
  );
}
