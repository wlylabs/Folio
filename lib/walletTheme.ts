import { darkTheme, lightTheme, type Theme } from "@rainbow-me/rainbowkit";
import type { ResolvedTheme } from "@/lib/theme";

/**
 * The print palette, mirroring the custom properties in app/globals.css.
 * RainbowKit's theme is a plain JS object handed to a provider, so it can't
 * read `var(--ink)` for values it composes into gradients or shadows.
 *
 * Both palettes are here for the same reason, and they are the same palette:
 * every value below is the day or night token of the same name. The modal is
 * the one surface in the app Folio does not draw itself, and it is the one most
 * likely to give away that a theme was bolted on — a wallet list in full
 * daylight, opened from a page that is dark, is the whole illusion gone.
 */
export const PAPER = "#f7f6f2";
export const PAPER_RAISED = "#fffdf8";
export const INK = "#14120e";
export const INK_SOFT = "#55514a";
export const INK_MUTED = "#6f6a61";
export const RULE = "#dbd6cb";
export const ALERT = "#a4222f";

export const NIGHT_PAPER = "#0d0d0c";
export const NIGHT_PAPER_RAISED = "#161614";
export const NIGHT_INK = "#f3f1ea";
export const NIGHT_INK_SOFT = "#b8b2a6";
export const NIGHT_INK_MUTED = "#948d80";
export const NIGHT_RULE = "#34322c";
export const NIGHT_ALERT = "#ff6b5e";

const SQUARE = {
  actionButton: "0px",
  connectButton: "0px",
  menuButton: "0px",
  modal: "0px",
  modalMobile: "0px",
} as const;

/** A single hard offset reads like a letterpress impression; RainbowKit's own
 *  default is a soft blurred halo that doesn't exist anywhere else in Folio. */
const FLAT_SHADOWS = {
  connectButton: "none",
  profileDetailsAction: "none",
  selectedOption: "none",
  selectedWallet: "none",
} as const;

/**
 * Folio's wallet modal: newsprint instead of the default rounded, drop-shadowed
 * card. The trigger button is ours (components/WalletButton.tsx), so only the
 * modal chrome — wallet list, account details, chain switcher — is styled here.
 */
export const folioWalletTheme: Theme = (() => {
  const base = lightTheme({
    accentColor: INK,
    accentColorForeground: PAPER,
    borderRadius: "none",
    fontStack: "system",
    overlayBlur: "none",
  });

  return {
    ...base,
    fonts: { body: '"Inter", sans-serif' },
    colors: {
      ...base.colors,
      accentColor: INK,
      accentColorForeground: PAPER,
      actionButtonBorder: RULE,
      actionButtonBorderMobile: RULE,
      actionButtonSecondaryBackground: PAPER,
      closeButton: INK_SOFT,
      closeButtonBackground: "transparent",
      connectionIndicator: INK,
      error: ALERT,
      generalBorder: RULE,
      generalBorderDim: RULE,
      menuItemBackground: "rgba(20, 18, 14, 0.05)",
      modalBackdrop: "rgba(20, 18, 14, 0.45)",
      modalBackground: PAPER,
      modalBorder: INK,
      modalText: INK,
      modalTextDim: INK_MUTED,
      modalTextSecondary: INK_SOFT,
      profileAction: PAPER_RAISED,
      profileActionHover: "rgba(20, 18, 14, 0.06)",
      profileForeground: PAPER,
      selectedOptionBorder: INK,
      standby: INK_SOFT,
    },
    radii: { ...SQUARE },
    shadows: { ...base.shadows, ...FLAT_SHADOWS, dialog: "6px 6px 0 rgba(0, 0, 0, 0.14)" },
  };
})();

/**
 * The same modal after dark.
 *
 * Built from RainbowKit's dark base rather than by darkening the light one, so
 * the parts the theme object has no token for — the QR code, the wallet
 * artwork's backing, the loading shimmer — come out right rather than nearly
 * right. Everything Folio does have a token for is then set to the night
 * palette above.
 */
export const folioWalletThemeDark: Theme = (() => {
  const base = darkTheme({
    accentColor: NIGHT_INK,
    accentColorForeground: NIGHT_PAPER,
    borderRadius: "none",
    fontStack: "system",
    overlayBlur: "none",
  });

  return {
    ...base,
    fonts: { body: '"Inter", sans-serif' },
    colors: {
      ...base.colors,
      accentColor: NIGHT_INK,
      accentColorForeground: NIGHT_PAPER,
      actionButtonBorder: NIGHT_RULE,
      actionButtonBorderMobile: NIGHT_RULE,
      actionButtonSecondaryBackground: NIGHT_PAPER_RAISED,
      closeButton: NIGHT_INK_SOFT,
      closeButtonBackground: "transparent",
      connectionIndicator: NIGHT_INK,
      error: NIGHT_ALERT,
      generalBorder: NIGHT_RULE,
      generalBorderDim: NIGHT_RULE,
      menuItemBackground: "rgba(243, 241, 234, 0.06)",
      // Heavier than the day backdrop: a dark modal over a dark page needs the
      // page pushed further back to read as being behind it at all.
      modalBackdrop: "rgba(0, 0, 0, 0.66)",
      modalBackground: NIGHT_PAPER,
      modalBorder: NIGHT_RULE,
      modalText: NIGHT_INK,
      modalTextDim: NIGHT_INK_MUTED,
      modalTextSecondary: NIGHT_INK_SOFT,
      profileAction: NIGHT_PAPER_RAISED,
      profileActionHover: "rgba(243, 241, 234, 0.08)",
      profileForeground: NIGHT_PAPER_RAISED,
      selectedOptionBorder: NIGHT_INK,
      standby: NIGHT_INK_SOFT,
    },
    radii: { ...SQUARE },
    shadows: {
      ...base.shadows,
      ...FLAT_SHADOWS,
      // The impression, inverted the same way the page's press shadow is: on a
      // dark page the offset is light, and reads as the raised edge catching it.
      dialog: "6px 6px 0 rgba(243, 241, 234, 0.1)",
    },
  };
})();

export function walletThemeFor(theme: ResolvedTheme): Theme {
  return theme === "dark" ? folioWalletThemeDark : folioWalletTheme;
}
