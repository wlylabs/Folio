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

/**
 * Plain text into paragraph HTML, with every angle bracket escaped.
 *
 * What the addition composer writes with (see components/AddendumComposer.tsx).
 * An addition is a paragraph or two of prose typed into a textarea, and it is
 * stored as HTML so that one render path serves it and the article body alike.
 *
 * Escaping rather than sanitising is the whole point of this function.
 * {@link sanitizeArticleHtml} answers "which tags may survive" and its answer
 * for anything it does not recognise is to *drop* it — which is right for an
 * editor that emits markup and quietly wrong for a person typing, because
 * "a < b" would lose the rest of the sentence and nothing would say so. Here
 * the input is not markup at all, so every bracket is text and is written as
 * text. The result still goes through the sanitiser on the way out; this is the
 * belt, that is the braces.
 */
export function paragraphsToHtml(text: string | null | undefined): string {
  if (!text) return "";

  return text
    .replace(/\r\n/g, "\n")
    // A blank line is a paragraph break, the way it is in every plain-text
    // composer; a single newline is a line break inside one.
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text version of an article body, tags and entities gone. */
export function articleText(html: string | null | undefined): string {
  // Stripping the tags outright welds the last word of one block to the first
  // of the next — "...reached temperature.A slow start". Blocks are boundaries
  // between sentences, so they have to leave a space behind.
  const spaced = (html || "").replace(
    /<\/(p|div|h[1-6]|li|blockquote|pre|tr|section|article)>|<(br|hr)\s*\/?>/gi,
    " "
  );

  return sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

/** Plain text version of an article body, for previews and meta descriptions. */
export function articleExcerpt(html: string | null | undefined, maxLength = 160): string {
  const text = articleText(html);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
