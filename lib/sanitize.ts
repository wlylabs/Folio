import sanitizeHtml from "sanitize-html";

/**
 * Allowlist matching what Tiptap's StarterKit can actually produce. Anything
 * else — script, iframe, style, event handlers, javascript: URLs — is dropped.
 *
 * This matters because article_body is written through the public Supabase
 * anon key and rendered with dangerouslySetInnerHTML. Treat every stored body
 * as attacker-controlled regardless of which editor produced it.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "s", "strike", "u", "code",
    "blockquote", "pre",
    "ul", "ol", "li",
    "a",
  ],
  allowedAttributes: {
    // rel/target must be allowed for the transformTags hardening below to
    // survive attribute filtering; simpleTransform overwrites whatever the
    // author supplied, so these cannot be abused.
    a: ["href", "title", "rel", "target"],
    code: ["class"],
    pre: ["class"],
  },
  // Anchors keep only web-safe schemes; javascript:/data: are stripped.
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  // Outbound links from untrusted articles must not get window.opener access.
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      rel: "nofollow noopener noreferrer",
      target: "_blank",
    }),
  },
  disallowedTagsMode: "discard",
};

/** Sanitize stored article HTML for rendering. */
export function sanitizeArticleHtml(html: string | null | undefined): string {
  if (!html) return "";
  return sanitizeHtml(html, OPTIONS);
}

/** Plain text version of an article body, for previews and meta descriptions. */
export function articleExcerpt(html: string | null | undefined, maxLength = 160): string {
  // Stripping the tags outright welds the last word of one block to the first
  // of the next — "...reached temperature.A slow start". Blocks are boundaries
  // between sentences, so they have to leave a space behind.
  const spaced = (html || "").replace(
    /<\/(p|div|h[1-6]|li|blockquote|pre|tr|section|article)>|<(br|hr)\s*\/?>/gi,
    " "
  );

  const text = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
