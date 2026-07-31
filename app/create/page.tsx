import type { Metadata } from "next";
import LaunchForm from "./LaunchForm";
import { pageTitle, socialMetadata } from "@/lib/seo";

/**
 * The launchpad: an article with a token behind it, and the only way onto
 * Folio.
 *
 * It used to share a tab strip with article mode, which read as two settings of
 * one form. They were never that, and the article side is gone — this page is
 * about one thing: your article, your token, one transaction.
 *
 * The form is a client component — it holds an editor, a wallet connection and
 * a transaction — and a "use client" module cannot export `metadata`. This page
 * is the server boundary that can, and it renders the form and nothing else.
 */

const TITLE = "Launch a token";

const DESCRIPTION =
  "Write your article, publish it, and the token it describes is minted onto a bonding curve in one transaction. Testnet ETH from a faucet covers the gas.";

export const metadata: Metadata = {
  title: pageTitle(TITLE),
  description: DESCRIPTION,
  alternates: { canonical: "/create" },
  ...socialMetadata({ title: TITLE, description: DESCRIPTION, path: "/create" }),
};

export default function CreatePage() {
  return <LaunchForm />;
}
