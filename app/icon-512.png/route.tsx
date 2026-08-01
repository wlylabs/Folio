import { folioIcon } from "@/lib/appIcon";

/** The manifest's large icon: splash screens, and anywhere a launcher wants
 *  something it can scale down itself. See app/icon-192.png. */
export const dynamic = "force-static";

export function GET() {
  return folioIcon({ size: 512, inset: 0.14 });
}
