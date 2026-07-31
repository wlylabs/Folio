import type { Metadata } from "next";
import LegalDocumentPage from "@/components/LegalDocument";
import { loadLegalDocument } from "@/lib/legal";

// See app/terms/page.tsx — same reasoning.
export const dynamic = "force-static";

const doc = loadLegalDocument("privacy");

export const metadata: Metadata = {
  title: doc.metaTitle,
  description: doc.metaDescription,
  alternates: { canonical: "/privacy" },
  openGraph: {
    title: doc.metaTitle,
    description: doc.metaDescription,
    url: "/privacy",
    type: "article",
    modifiedTime: doc.lastUpdated ?? undefined,
  },
};

export default function PrivacyPage() {
  return <LegalDocumentPage doc={doc} />;
}
