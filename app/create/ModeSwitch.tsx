import Link from "next/link";

/**
 * The two things Folio publishes, as a switch above the form.
 *
 * They are two routes rather than one route with a tab, because they are two
 * different pages in every sense that matters: different metadata, different
 * canonical, different thing to explain to a reader arriving from search. A tab
 * would have made `/create` mean both and neither.
 *
 * Rendered by both forms so the other mode is always one press away, and
 * `aria-current` rather than a class alone carries which one you are on — a
 * switch that only says so in colour says nothing to a screen reader.
 */
export type Mode = "article" | "launchpad";

const MODES: { mode: Mode; href: string; label: string; hint: string }[] = [
  {
    mode: "article",
    href: "/create/article",
    label: "Article",
    hint: "Written by the desk agent. No token, no wallet, no gas.",
  },
  {
    mode: "launchpad",
    href: "/create",
    label: "Launchpad",
    hint: "Your article, and the token it describes, in one transaction.",
  },
];

export default function ModeSwitch({ current }: { current: Mode }) {
  const hint = MODES.find((entry) => entry.mode === current)?.hint;

  return (
    <div className="modes" role="group" aria-label="What to publish">
      <div className="modes__row">
        {MODES.map((entry) => (
          <Link
            key={entry.mode}
            href={entry.href}
            className="modes__tab"
            aria-current={entry.mode === current ? "page" : undefined}
          >
            {entry.label}
          </Link>
        ))}
      </div>
      {hint && <p className="modes__hint">{hint}</p>}
    </div>
  );
}
