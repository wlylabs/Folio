/**
 * Light or dark: which palette app/globals.css paints the page in.
 *
 * Folio's language is print — warm paper, one ink, hairline rules — and the
 * dark palette is not a second design. It is the same page after dark: the
 * paper goes to near-black, the ink to bone, and every rule, shadow and figure
 * keeps the relationship it had. Nothing is restyled by hand for it, because
 * everything the interface is made of is already a custom property.
 *
 * There are two states worth keeping apart, and this module keeps them apart
 * everywhere:
 *
 *  - the **preference**, which is what the reader chose and what gets stored:
 *    `system`, `light` or `dark`;
 *  - the **resolved theme**, which is the one actually on screen — the
 *    preference, or the operating system's answer when the preference defers
 *    to it.
 *
 * A reader who never opens the settings panel is on `system` and gets whatever
 * their machine is set to, which is the only default that is right for both the
 * person reading in bed and the person reading at a desk.
 */

export type ThemePreference = "system" | "light" | "dark";

/** What the page is actually painted in, once `system` has been asked. */
export type ResolvedTheme = "light" | "dark";

/** localStorage key holding the reader's choice. */
export const THEME_KEY = "folio_theme_pref";

/** Fired on the window when the choice changes, so other trees follow along. */
export const THEME_EVENT = "folio:theme";

export const DEFAULT_THEME: ThemePreference = "system";

/** The media query that answers for `system`. */
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * The paper colour of each palette, as a literal.
 *
 * It is the one value in this file that duplicates something in
 * app/globals.css — `--paper`, in both blocks — and it has to, because the two
 * places that need it cannot read a stylesheet: `<meta name="theme-color">`,
 * which is what a phone paints its address bar and its gesture area with, and
 * the manifest's `theme_color`/`background_color`, which is what the operating
 * system paints the splash screen and the task-switcher card with. app/og.png
 * carries the same copy for the same reason.
 *
 * Keep the three in step. A drift here is not subtle: it is a band of the wrong
 * colour along the top of every phone that has the site installed.
 */
export const THEME_CANVAS: Record<ResolvedTheme, string> = {
  light: "#f7f6f2",
  dark: "#0d0d0c",
};


export const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Day" },
  { value: "dark", label: "Night" },
] as const;

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * The stored choice, or null if this reader has not made one.
 *
 * Null on the server and in any browser where localStorage throws — Safari in
 * private mode, storage disabled by policy — which every caller reads as "ask
 * the system", never as an error.
 */
export function readTheme(): ThemePreference | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return isThemePreference(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Remember a choice and tell the rest of the page about it. */
export function writeTheme(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_KEY, preference);
  } catch {
    // Storage unavailable. The choice still applies to this page view; it just
    // will not survive a reload, which is the harmless way to fail.
  }

  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: preference }));
}

/** What the operating system is set to, or `light` where nothing can answer. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

/**
 * The theme, applied to the document.
 *
 * `data-theme` is what the stylesheet keys its palettes off; `color-scheme` is
 * what the browser keys the things the stylesheet cannot reach off — scrollbar
 * furniture, the form controls it draws itself, the flash of white it paints
 * between navigations. Both are set together, always, because a page whose
 * scrollbar is the wrong theme is the one detail that gives away that dark mode
 * was bolted on.
 *
 * `theme-color` is the third of the same kind, and the largest: on a phone it is
 * the address bar above the page and the gesture strip below it. Left unset, a
 * reader on the night page gets a full-width band of the browser's own colour
 * top and bottom — and on a reload, that band changes colour a beat after the
 * page does, which is the flash this is here to remove.
 */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", THEME_CANVAS[theme]);
}
