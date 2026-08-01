import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";

/**
 * The legal pages render the markdown files at the repo root — TERMS.md and
 * PRIVACY.md — rather than a second copy pasted into JSX. One document, one
 * place to edit, and a diff on the policy is a diff on the file a reviewer
 * would ask for.
 *
 * The read happens at build time. Both routes are `force-static`, so the HTML
 * is baked into the output and no serverless function ever touches the disk
 * looking for a markdown file that file tracing may not have bundled.
 */

export type LegalSlug = "terms" | "privacy";

type LegalSource = {
  /** Markdown file at the repo root. */
  file: string;
  /** <title> and og:title for the route. */
  metaTitle: string;
  /** Meta description. Written here, not derived: the documents open with a
   *  draft warning, which is not what a search result should lead with. */
  metaDescription: string;
  /**
   * Shows the "Draft — pending legal review" badge above the document.
   *
   * TO REMOVE THE BADGE: set this to false once the document has been through
   * legal review. That is the only change needed — the badge is the only thing
   * reading this flag.
   */
  draft: boolean;
};

const SOURCES: Record<LegalSlug, LegalSource> = {
  terms: {
    file: "TERMS.md",
    metaTitle: "Terms of Service — Folio",
    metaDescription:
      "The terms governing use of Folio, a token launchpad where every token is published as an article.",
    draft: true,
  },
  privacy: {
    file: "PRIVACY.md",
    metaTitle: "Privacy Policy — Folio",
    metaDescription:
      "What Folio collects, what it never collects, and why on-chain data cannot be deleted.",
    draft: true,
  },
};

export type LegalDocument = {
  slug: LegalSlug;
  /** The document's own H1, lifted out so the page owns the heading. */
  title: string;
  /** Everything below the H1, as HTML. */
  bodyHtml: string;
  /** Parsed from the "Last updated:" line, for the <time> byline. */
  lastUpdated: string | null;
  draft: boolean;
  metaTitle: string;
  metaDescription: string;
};

/** The `# Heading` on the first line, and the markdown that follows it. */
function splitTitle(markdown: string): { title: string; rest: string } {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  if (!match || match.index === undefined) {
    return { title: "", rest: markdown };
  }
  const rest = markdown.slice(0, match.index) + markdown.slice(match.index + match[0].length);
  return { title: match[1], rest };
}

/**
 * `Last updated: 2026-07-31`, if it has been filled in. A document still
 * carrying the `[FILL IN DATE]` placeholder reports null rather than printing
 * the placeholder into the byline.
 */
function findLastUpdated(markdown: string): string | null {
  const match = markdown.match(/^Last updated:\s*(.+?)\s*$/m);
  if (!match) return null;
  const value = match[1].trim();
  return value.startsWith("[") ? null : value;
}

export function loadLegalDocument(slug: LegalSlug): LegalDocument {
  const source = SOURCES[slug];
  const markdown = fs.readFileSync(path.join(process.cwd(), source.file), "utf8");
  const { title, rest } = splitTitle(markdown);

  return {
    slug,
    title: title || source.metaTitle,
    // Trusted input: a file in this repo, read at build time, reviewed in the
    // same pull request as the code. Not user content, so it does not go
    // through lib/sanitize.ts — that allowlist exists for article bodies
    // written through the public Supabase anon key.
    // `breaks` because the documents use a single newline as a line break in
    // their front matter — the draft warning sits under the status line, and
    // without this the two run together into one paragraph.
    bodyHtml: marked.parse(rest, { async: false, gfm: true, breaks: true }),
    lastUpdated: findLastUpdated(markdown),
    draft: source.draft,
    metaTitle: source.metaTitle,
    metaDescription: source.metaDescription,
  };
}
