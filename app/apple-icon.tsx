import { folioIcon } from "@/lib/appIcon";

/**
 * The home-screen icon on iOS, which reads none of the manifest's.
 *
 * Safari takes `apple-touch-icon` and nothing else, at 180px, and it does not
 * mask or pad what it is given — it rounds the corners itself. So this is the
 * mark on its own paper at the ordinary inset, and Next emits the <link> for
 * it from this file's presence alone.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return folioIcon({ size: 180, inset: 0.14 });
}
