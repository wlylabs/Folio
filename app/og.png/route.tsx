import { ImageResponse } from "next/og";
import { DEFAULT_OG_IMAGE_SIZE, SITE_NAME, SITE_TAGLINE } from "@/lib/seo";

/**
 * The share card a link to Folio falls back to — the front page, the launch
 * form, and any listing whose token has no avatar of its own.
 *
 * It is a route rather than the `app/opengraph-image` file convention because
 * that convention only fills in for a segment whose metadata does not mention
 * `openGraph.images`, and token pages do mention it. A card that only appears
 * on some pages is worse than one with a URL anything can point at.
 *
 * `force-static` renders it once at build and serves the PNG from the static
 * output, so no crawler fetch ever runs satori.
 */
export const dynamic = "force-static";

// The palette and the print language of app/globals.css, in the one place that
// cannot read a stylesheet.
const PAPER = "#f7f6f2";
const INK = "#14120e";
const INK_MUTED = "#6f6a61";
const RULE = "#b6b0a2";

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          color: INK,
          padding: "64px 72px",
          border: `2px solid ${INK}`,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 22,
            letterSpacing: 6,
            textTransform: "uppercase",
            color: INK_MUTED,
          }}
        >
          {/*
            A masthead rule, not a date line: nothing here should assert a
            founding year or anything else that would need maintaining.
          */}
          <span>Testnet edition</span>
          <span>The listing is the article</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 168,
              fontWeight: 700,
              letterSpacing: -4,
              lineHeight: 1,
            }}
          >
            {SITE_NAME.toUpperCase()}
          </div>
          <div
            style={{
              width: "100%",
              height: 2,
              background: RULE,
              margin: "36px 0",
            }}
          />
          <div style={{ fontSize: 52, lineHeight: 1.2 }}>{SITE_TAGLINE}</div>
        </div>

        <div style={{ display: "flex", fontSize: 26, color: INK_MUTED }}>
          A launchpad where the listing is the article.
        </div>
      </div>
    ),
    DEFAULT_OG_IMAGE_SIZE
  );
}
