import type { Metadata } from "next";
import LaunchForm from "./LaunchForm";
import { pageTitle, socialMetadata } from "@/lib/seo";

/**
 * The launchpad: an article with a token behind it, and the only way onto Folio
 * for anyone who is not staff.
 *
 * It used to share a tab strip with article mode, which read as two settings of
 * one form. They were never that. The agent's desk moved to /desk behind a
 * password — it publishes free, so it cannot be public — and this page is now
 * about one thing: your article, your token, one transaction. What the desk
 * publishes is read-only to everyone here, in Postfolio.
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
