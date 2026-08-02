import { sanitizeArticleHtml } from "@/lib/sanitize";
import { formatDate, shortAddress } from "@/lib/types";
import type { Addendum } from "@/lib/addenda";

/**
 * What the author added after publishing, in the order they added it.
 *
 * This is the part of a Folio listing a blog cannot have. A blog corrects
 * itself by rewriting the paragraph: the sentence that made the case is gone,
 * the date at the top is unchanged, and nobody arriving later can tell that the
 * piece they are reading is not the piece other people acted on. Here the
 * article is fixed at publication — `lib/schema.sql` refuses updates and
 * deletes from every client — and second thoughts are appended underneath,
 * each one signed by the byline and each one permanent.
 *
 * They sit between the article and the trade panel, which is the one placement
 * that is not a matter of taste: a retraction the reader meets *after* the buy
 * button is a retraction that arrived too late to be worth publishing.
 *
 * Rendered on the server like the article itself, so an addition is in the HTML
 * a crawler reads and not only in the one a browser assembles.
 */
export default function Addenda({ addenda }: { addenda: Addendum[] }) {
  if (addenda.length === 0) return null;

  return (
    <section className="addenda" aria-labelledby="addenda-heading">
      <h2 id="addenda-heading" className="addenda__title">
        {addenda.length === 1 ? "One addition" : `${addenda.length} additions`}
      </h2>

      <p className="addenda__note">
        The article above is exactly as it was published — Folio cannot rewrite
        it and neither can its author. Everything below was added afterwards,
        signed by the address on the byline, and cannot be edited or taken down
        either.
      </p>

      <ol className="addenda__list">
        {addenda.map((addendum) => (
          <li key={addendum.id} className="addendum">
            <p className="addendum__head">
              <time dateTime={addendum.created_at}>{formatDate(addendum.created_at)}</time>
              <span aria-hidden="true">·</span>
              <span>
                signed by{" "}
                <b className="mono">{shortAddress(addendum.author_wallet)}</b>
              </span>
            </p>

            <div
              className="addendum__body prose"
              // Sanitized server-side. It is built from plain text by
              // lib/sanitize.ts on the way in, and treated as untrusted on the
              // way out regardless — it arrived from a browser.
              dangerouslySetInnerHTML={{ __html: sanitizeArticleHtml(addendum.body) }}
            />
          </li>
        ))}
      </ol>
    </section>
  );
}
