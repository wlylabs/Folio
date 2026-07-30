import { lightTheme, type Theme } from "@rainbow-me/rainbowkit";

/**
 * The print palette, mirroring the custom properties in app/globals.css.
 * RainbowKit's theme is a plain JS object handed to a provider, so it can't
 * read `var(--ink)` for values it composes into gradients or shadows.
 */
export const PAPER = "#f7f6f2";
export const PAPER_RAISED = "#fffdf8";
export const INK = "#14120e";
export const INK_SOFT = "#55514a";
export const INK_MUTED = "#6f6a61";
export const RULE = "#dbd6cb";
export const ALERT = "#a4222f";

const base = lightTheme({
  accentColor: INK,
  accentColorForeground: PAPER,
  borderRadius: "none",
  fontStack: "system",
  overlayBlur: "none",
});

/**
 * Folio's wallet modal: newsprint instead of the default rounded, drop-shadowed
 * card. The trigger button is ours (components/WalletButton.tsx), so only the
 * modal chrome — wallet list, account details, chain switcher — is styled here.
 */
export const folioWalletTheme: Theme = {
  ...base,
  fonts: {
    body: '"Inter", sans-serif',
  },
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
  radii: {
    actionButton: "0px",
    connectButton: "0px",
    menuButton: "0px",
    modal: "0px",
    modalMobile: "0px",
  },
  shadows: {
    ...base.shadows,
    // A single hard offset reads like a letterpress impression; the default is
    // a soft blurred halo that doesn't exist anywhere else in Folio.
    connectButton: "none",
    dialog: "6px 6px 0 rgba(0, 0, 0, 0.14)",
    profileDetailsAction: "none",
    selectedOption: "none",
    selectedWallet: "none",
    walletLogo: "none",
  },
};
