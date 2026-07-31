import { serializeJsonLd } from "@/lib/seo";

/**
 * A schema.org payload, rendered into the page for crawlers.
 *
 * This is a server component and must stay one: the script tag has to be in
 * the HTML the server sends, because a crawler that reads the markup without
 * running the app is exactly the reader it is for.
 *
 * The escaping in serializeJsonLd is what makes dangerouslySetInnerHTML safe
 * here — see the note on that function before passing it anything new.
 */
export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
