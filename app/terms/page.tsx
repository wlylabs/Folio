import type { Metadata } from "next";
import LegalDocumentPage from "@/components/LegalDocument";
import { loadLegalDocument } from "@/lib/legal";

// Prerendered at build time: the document comes off disk, and a static page is
// what a crawler (and a reader on a bad connection) should get.
export const dynamic = "force-static";

// Read once at module scope — the metadata and the page render the same object.
const doc = loadLegalDocument("terms");

export const metadata: Metadata = {
  title: doc.metaTitle,
  description: doc.metaDescription,
  alternates: { canonical: "/terms" },
  openGraph: {
    title: doc.metaTitle,
    description: doc.metaDescription,
    url: "/terms",
    type: "article",
    modifiedTime: doc.lastUpdated ?? undefined,
  },
};

export default function TermsPage() {
  return <LegalDocumentPage doc={doc} />;
}
