import type { Metadata } from "next";
import { pageTitle, socialMetadata } from "@/lib/seo";

/**
 * The launch form is a client component — it holds an editor, a wallet
 * connection and a transaction — and a "use client" module cannot export
 * `metadata`. This layout is the server boundary that can, and it adds no
 * markup: it renders its child and nothing else.
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

export default function CreateLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
