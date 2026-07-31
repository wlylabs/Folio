import type { Metadata } from "next";
import ArticleComposer from "../ArticleComposer";
import { pageTitle, socialMetadata } from "@/lib/seo";

/**
 * Article mode: a piece of writing with no token behind it.
 *
 * The composer is a client component, so this page is the server boundary that
 * can carry metadata — including its own canonical, which matters here: without
 * one this route would inherit /create's and tell search engines the two pages
 * are the same page.
 */

const TITLE = "Write an article";

const DESCRIPTION =
  "Folio's desk agent reads what AI, technology and crypto outlets syndicated today and writes one attributed article about the thread running through them. Review it, then publish — no token, no wallet, no gas.";

export const metadata: Metadata = {
  title: pageTitle(TITLE),
  description: DESCRIPTION,
  alternates: { canonical: "/create/article" },
  ...socialMetadata({ title: TITLE, description: DESCRIPTION, path: "/create/article" }),
};

export default function CreateArticlePage() {
  return <ArticleComposer />;
}
