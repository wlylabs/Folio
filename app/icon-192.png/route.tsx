import { folioIcon } from "@/lib/appIcon";

/**
 * The manifest's small icon — the one a launcher shows in a list, and the one
 * Chrome puts in the install prompt.
 *
 * A route rather than the `app/icon.*` file convention, because that convention
 * produces the favicon and nothing else: the manifest needs URLs it can name,
 * at sizes it declares. app/icon.svg stays where it is and keeps doing the tab.
 */
export const dynamic = "force-static";

export function GET() {
  // Close to the edge: this one is never masked, so the mark can use its frame.
  return folioIcon({ size: 192, inset: 0.14 });
}
