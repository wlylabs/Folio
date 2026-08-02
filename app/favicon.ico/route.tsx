import { folioIcon } from "@/lib/appIcon";

/**
 * The mark for everything that guesses at a favicon's address instead of
 * reading the page.
 *
 * app/icon.svg already covers browsers: it emits a <link rel="icon"> and a tab
 * follows it. But a great deal of software never parses the HTML — dApp
 * directories, wallet connection sheets, link unfurlers, favicon proxies — and
 * simply requests /favicon.ico off the origin. Without this route that request
 * 404s, and each of those surfaces falls back to a generated placeholder,
 * usually a coloured square holding the first letter of the domain. Being
 * listed somewhere with a stranger's initial on it is worse than not being
 * listed, so the well-known address answers too.
 *
 * The bytes are a PNG, despite the name. The `.ico` container has not been
 * required by anything since IE, every consumer sniffs the content type, and
 * emitting one here would mean checking in a binary that the drawing in
 * lib/appIcon.tsx could then drift away from. 64px because these consumers
 * scale down to 16 or 32 far more gracefully than a 16px render scales up.
 */
export const dynamic = "force-static";

export function GET() {
  // The same framing as the 192 copy, so the tab, the home screen and a
  // directory listing are all recognisably one mark.
  return folioIcon({ size: 64, inset: 0.14 });
}
