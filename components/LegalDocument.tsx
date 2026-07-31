import type { LegalDocument } from "@/lib/legal";

/**
 * A policy, set as an article. Same reading column and same serif body as a
 * token's article page, because it is the same kind of object: a long document
 * someone has to actually read.
 *
 * A server component with no wallet dependency anywhere in it — these pages
 * have to open for a reader who has never connected anything.
 */
export default function LegalDocumentPage({ doc }: { doc: LegalDocument }) {
  return (
    <main id="main" className="shell shell--measure page">
      <article className="legal">
        <header className="legal__head">
          {doc.draft && (
            // Removed by flipping `draft` in lib/legal.ts once the document
            // has been through legal review.
            <p className="legal__badge">Draft — pending legal review</p>
          )}

          {/*
            * No "last updated" byline here, editorially tempting as one is:
            * each document already states its own date a few lines into the
            * body, and printing it twice reads as a bug. The parsed date goes
            * to og:modified_time instead.
            */}
          <h1 className="legal__title">{doc.title}</h1>
        </header>

        {/* Build-time markdown from this repo, not user content. See lib/legal.ts. */}
        <div className="prose" dangerouslySetInnerHTML={{ __html: doc.bodyHtml }} />
      </article>
    </main>
  );
}
