import { ImageResponse } from "next/og";
import { THEME_CANVAS } from "./theme";

/**
 * The app icon, at whatever size the thing asking for it wants.
 *
 * It is drawn rather than stored, for the same reason app/og.png is: the shape
 * is two rectangles, satori draws those exactly, and a generated icon cannot
 * drift from the mark the way a binary checked in beside it would. Every caller
 * is a route with `force-static`, so this runs at build and the output is a
 * plain PNG on the CDN — no request ever renders one.
 *
 * The mark is components/Logo.tsx and app/icon.svg: a sheet with a fold down
 * the middle. Ink on paper, never inverted — an icon sits on a home screen
 * whose wallpaper this page has no say in, and the printed page is the thing
 * being represented.
 */

const INK = "#14120e";
const PAPER = THEME_CANVAS.light;

type IconOptions = {
  /** Width and height in pixels. Icons are square everywhere they are used. */
  size: number;
  /**
   * Fraction of the frame left empty around the mark.
   *
   * `maskable` icons are cropped to whatever shape the platform likes — a
   * circle on one launcher, a squircle on the next — and the spec guarantees
   * only the middle 80% survives. A mark drawn to the edge loses its corners on
   * Android and its fold on nothing at all, so the maskable copy is drawn small
   * inside its paper and the ordinary copy is drawn close to the edge.
   */
  inset: number;
};

export function folioIcon({ size, inset }: IconOptions): ImageResponse {
  // The sheet's proportions come from components/Logo.tsx — 16 wide by 19 tall,
  // an edge at 9% of the width and a crease at 14% — rather than from
  // app/icon.svg, whose strokes are deliberately heavier because a favicon is
  // drawn at 16px and these never are. Kept as ratios, so every size is the
  // same drawing rather than a set of hand-tuned ones.
  const height = size * (1 - inset * 2);
  const width = (height * 16) / 19;
  const stroke = Math.max(2, Math.round(width * 0.094));
  const fold = Math.max(3, Math.round(width * 0.14));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: PAPER,
        }}
      >
        {/*
          The fold is a centred child rather than a border on a half-width box:
          box-sizing is border-box here, so a half-width box puts its right edge
          short of the middle and the crease lands visibly off-centre. Same note
          as app/og.png, same reason.
        */}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            width,
            height,
            border: `${stroke}px solid ${INK}`,
          }}
        >
          <div style={{ width: fold, height: "100%", background: INK }} />
        </div>
      </div>
    ),
    { width: size, height: size }
  );
}
