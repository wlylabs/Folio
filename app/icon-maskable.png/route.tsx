import { folioIcon } from "@/lib/appIcon";

/**
 * The same mark, drawn for a launcher that is going to cut a shape out of it.
 *
 * Android crops every icon to the platform's current mask — a circle, a
 * squircle, a rounded square, whichever the reader's launcher is set to — and
 * only guarantees the middle 80%. So this copy keeps the mark well inside that
 * circle and lets the paper take the crop, which is the whole point of a
 * separate `purpose: "maskable"` entry: without one, Android draws the ordinary
 * icon on a white plate of its own and the result is a small sheet floating in
 * a large circle.
 */
export const dynamic = "force-static";

export function GET() {
  return folioIcon({ size: 512, inset: 0.28 });
}
