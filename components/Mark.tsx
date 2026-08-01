import { isHttpUrl } from "@/lib/url";

/**
 * A launch's identity square: the uploaded avatar, or its symbol's initials
 * when there isn't one.
 *
 * The avatar is optional, so a feed of real launches is a mix of images and
 * gaps. Falling back to a monogram keeps every card the same shape, which is
 * what makes the grid read as a grid.
 *
 * That fallback is also what a hostile `avatar_url` gets. The column is written
 * through the public anon key and constrained by nothing (lib/schema.sql), so
 * the value here is a string a stranger chose — anything that is not plainly an
 * http(s) URL is a monogram instead of an <img> pointed somewhere unknown. The
 * Content-Security-Policy in lib/securityHeaders.js narrows the surviving case
 * further, to the storage bucket the launch form actually uploads to.
 */
export default function Mark({
  src,
  symbol,
  name,
  size = "md",
}: {
  src: string | null | undefined;
  symbol: string;
  name?: string;
  size?: "sm" | "md" | "lg";
}) {
  const className = `mark${size === "lg" ? " mark--lg" : size === "sm" ? " mark--sm" : ""}`;

  if (isHttpUrl(src)) {
    return (
      // Plain <img>: next/image is deliberately unused, see next.config.js.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={`${name ?? symbol} avatar`} className={className} loading="lazy" />
    );
  }

  return (
    <span className={className} aria-hidden="true">
      {symbol.slice(0, 2).toUpperCase() || "—"}
    </span>
  );
}
