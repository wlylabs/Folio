import type { Metadata } from "next";
import LegalDocumentPage from "@/components/LegalDocument";
import { loadLegalDocument } from "@/lib/legal";
import { socialMetadata } from "@/lib/seo";

// See app/terms/page.tsx — same reasoning.
export const dynamic = "force-static";

const doc = loadLegalDocument("privacy");

export const metadata: Metadata = {
  title: doc.metaTitle,
  description: doc.metaDescription,
  alternates: { canonical: "/privacy" },
  ...socialMetadata({
    title: doc.metaTitle,
    description: doc.metaDescription,
    path: "/privacy",
    article: { modifiedTime: doc.lastUpdated ?? undefined },
  }),
};

export default function PrivacyPage() {
  return <LegalDocumentPage doc={doc} />;
}
