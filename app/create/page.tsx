import type { Metadata } from "next";
import LaunchForm from "./LaunchForm";
import { pageTitle, socialMetadata } from "@/lib/seo";

/**
 * Launchpad mode: an article with a token behind it.
 *
 * The form is a client component — it holds an editor, a wallet connection and
 * a transaction — and a "use client" module cannot export `metadata`. This page
 * is the server boundary that can, and it renders the form and nothing else.
 * Article mode is the sibling route, /create/article.
 */

const TITLE = "Launch a token";

const DESCRIPTION =
  "Write the article, publish it, and the token it describes is minted onto a bonding curve in one transaction. Testnet ETH from a faucet covers the gas.";

export const metadata: Metadata = {
  title: pageTitle(TITLE),
  description: DESCRIPTION,
  alternates: { canonical: "/create" },
  ...socialMetadata({ title: TITLE, description: DESCRIPTION, path: "/create" }),
};

export default function CreatePage() {
  return <LaunchForm />;
}
