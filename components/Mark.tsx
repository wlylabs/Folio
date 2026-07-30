/**
 * A launch's identity square: the uploaded avatar, or its symbol's initials
 * when there isn't one.
 *
 * The avatar is optional, so a feed of real launches is a mix of images and
 * gaps. Falling back to a monogram keeps every card the same shape, which is
 * what makes the grid read as a grid.
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

  if (src) {
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
