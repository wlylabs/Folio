import type { Metadata } from "next";
import { pageTitle } from "@/lib/seo";

/**
 * A desk is one wallet's own listings behind a wallet connection: there is no
 * public URL that renders the same thing twice, and nothing here that a search
 * result should ever land on. `noindex, follow` keeps it out of the index while
 * still letting a crawler follow the links out to the listings themselves,
 * which are the pages worth having.
 *
 * It is a layout rather than a `metadata` export on the page for the same
 * reason as /create: the page is a client component.
 */
export const metadata: Metadata = {
  title: pageTitle("Your desk"),
  description: "The listings published from your connected wallet.",
  robots: { index: false, follow: true },
};

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
