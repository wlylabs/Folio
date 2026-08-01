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
 */
export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/**
 * The same work, as a string, for a <script> in the document head.
 *
 * It has to run before the first paint. React cannot do that — the earliest it
 * can set an attribute is hydration, which is several hundred milliseconds and
 * one full-brightness flash of paper too late for a reader who asked for the
 * dark one. So the boot script reads the stored answer synchronously in the
 * head, and the provider below only ever agrees with what it already did.
 *
 * Everything it touches is in a try/catch: this runs before anything else on
 * the page, and a storage exception here would take the whole document with it.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var p=localStorage.getItem(${JSON.stringify(
  THEME_KEY
)});var t=(p==="light"||p==="dark")?p:(window.matchMedia&&window.matchMedia(${JSON.stringify(
  DARK_QUERY
)}).matches?"dark":"light");var r=document.documentElement;r.dataset.theme=t;r.style.colorScheme=t;}catch(e){}})();`;
