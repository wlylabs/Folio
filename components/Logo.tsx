/**
 * The Folio mark: a sheet folded once.
 *
 * A folio is literally that — one sheet, one fold, four pages — which is the
 * shortest way to draw both halves of what this site is: printed matter, and
 * a listing that opens like a page.
 *
 * Two strokes and nothing else, because the smallest this is ever drawn is a
 * 16px favicon and a third element turns to mush at that size. The crease
 * carries more weight than the sheet's edge: on a folded page the fold is the
 * darkest line, and it gives the mark its one moment of contrast.
 *
 * It inherits `currentColor` rather than naming an ink, so it takes the colour
 * of whatever it sits inside — the same way the wordmark does.
 */
export default function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      // Square corners and butt caps: the design system has no rounded
      // anything, and a rounded cap would read as a different family.
      strokeLinecap="butt"
      // Decorative in every place it is used — each one pairs it with the
      // word "Folio", so announcing it again would just repeat the name.
      aria-hidden="true"
      focusable="false"
    >
      {/* The sheet. Portrait, because a folio is taller than it is wide. */}
      <rect x="4" y="2.5" width="16" height="19" strokeWidth="1.5" />
      {/* The crease, dead centre — a folio folds exactly in half. */}
      <path d="M12 2.5V21.5" strokeWidth="2.25" />
    </svg>
  );
}
