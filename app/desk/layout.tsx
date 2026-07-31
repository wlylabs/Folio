import type { Metadata } from "next";
import { pageTitle } from "@/lib/seo";

/**
 * The article desk, on its own route and behind its own lock.
 *
 * It used to be a tab above the launch form, which made two unrelated things
 * look like two settings of one thing. They are not. The launchpad is the
 * public offer — anyone with a wallet writes a listing and mints the token it
 * describes, in one transaction. The desk is staff: it runs an agent against
 * the wires, spends a model quota, and publishes to the front page for free.
 * Separating the routes lets each page be about one job, and lets this one be
 * refused to everyone who is not running it.
 *
 * `noindex, nofollow`, and disallowed in robots.txt besides. There is nothing
 * here for a reader — the articles this desk produces are public at /read, and
 * that is the page a search result should land on.
 */
export const metadata: Metadata = {
  title: pageTitle("Article desk"),
  description: "Staff only. Where Folio's article desk drafts and publishes.",
  robots: { index: false, follow: false },
};

export default function DeskLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
