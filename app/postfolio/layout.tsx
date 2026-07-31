/**
 * The Postfolio shell.
 *
 * It renders one element and no chrome, which is the point: everything under
 * `/postfolio` is wrapped in `.pf`, and that class is what the blog half of
 * globals.css hangs off. Scoping the second view to a container rather than
 * giving it its own root layout keeps one masthead, one colophon and one set
 * of providers across both views — a reader switching sides should see the page
 * change, not the application reload around it.
 *
 * The wrapper is also why `.app-frame > .pf` exists in the stylesheet: <main>
 * is no longer a direct child of the frame here, so the rule that stops a short
 * page from floating its footer up the window has to reach one level further.
 */
export default function PostfolioLayout({ children }: { children: React.ReactNode }) {
  return <div className="pf">{children}</div>;
}
