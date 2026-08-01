/**
 * Whether a value is a URL a browser may be pointed at.
 *
 * It exists as its own module, rather than as one more function in lib/seo.ts,
 * because both a server component writing og:image and a client component
 * drawing an avatar need it — and lib/seo.ts imports the sanitiser, which
 * imports sanitize-html, which has no business in a browser bundle for the sake
 * of one protocol check.
 *
 * The values it is asked about all arrive the same way: `avatar_url` is
 * inserted through the public Supabase anon key, and the row-level policy in
 * lib/schema.sql constrains the name, the symbol and the address but says
 * nothing about this column. So it is a string a stranger chose. `javascript:`
 * in an <img src> does nothing, but it does nothing *visibly*, and a relative
 * or malformed value resolved against metadataBase throws during metadata
 * resolution and takes the page with it.
 */
export function isHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false;

  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
