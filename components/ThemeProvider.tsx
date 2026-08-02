"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  applyTheme,
  DARK_QUERY,
  DEFAULT_THEME,
  isThemePreference,
  readTheme,
  systemTheme,
  THEME_EVENT,
  THEME_KEY,
  writeTheme,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

type ThemeContextValue = {
  /** What the reader chose: `system`, `light` or `dark`. */
  preference: ThemePreference;
  /** What is actually on screen, once `system` has been asked. */
  theme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
};

/**
 * The fallback is the light page, which is what a tree mounted without the
 * provider would already be looking at: the boot script sets the attribute on
 * the document either way, so a missing provider costs the theme *control*, not
 * the theme.
 */
const ThemeContext = createContext<ThemeContextValue>({
  preference: DEFAULT_THEME,
  theme: "light",
  setPreference: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * Holds the reader's palette choice and keeps the document in step with it.
 *
 * The first render is deliberately the same one the server produced — the
 * default preference, resolving to light — because localStorage and matchMedia
 * are client-only and a first paint that disagreed with the server's HTML is a
 * hydration error. That costs nothing visually: `THEME_BOOT_SCRIPT` has already
 * put the right palette on the document before React ran, and nothing in the
 * tree renders a colour from this context. The effect below catches the state
 * up a frame later, which is when the settings panel starts showing the right
 * chip pressed and the wallet modal starts opening in the right theme.
 *
 * That placeholder first render is also why this component writes nothing to
 * the document until it has read the reader's answer, and why the resolved
 * theme below is derived rather than stored. Both are the same bug seen from
 * two sides: a state that says "light" for one pass because the server had to
 * say something, and a second state that would have to be walked from it to the
 * truth in steps. Applying either — the placeholder, or an intermediate step
 * through the system's answer for a reader who chose against it — repaints a
 * night page in daylight for a frame, hydration being long past the point where
 * `data-booting` holds transitions still. The reader sees the flash on every
 * refresh.
 *
 * Three things can change the answer afterwards, and all three are listened
 * for: the panel in this tab, the same panel in another tab, and the operating
 * system flipping under a reader who is on `system`.
 */
export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME);
  const [system, setSystem] = useState<ResolvedTheme>("light");
  /** Whether the two above are the reader's answer yet, or still the server's. */
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // One batched update, so the first render that has any of this has all of
    // it: `ready` never turns true alongside a stale preference.
    setPreferenceState(readTheme() ?? DEFAULT_THEME);
    setSystem(systemTheme());
    setReady(true);
  }, []);

  // Other trees and other tabs. A choice made in one settings panel should not
  // leave a second window on the old palette.
  useEffect(() => {
    const onChoice = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (isThemePreference(detail)) setPreferenceState(detail);
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_KEY && isThemePreference(event.newValue)) {
        setPreferenceState(event.newValue);
      }
    };

    window.addEventListener(THEME_EVENT, onChoice);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(THEME_EVENT, onChoice);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  /**
   * The system's answer, kept current while the reader is deferring to it.
   *
   * Only subscribed on `system` — a reader who has explicitly asked for the
   * light page should not have it go dark at sunset because their laptop does.
   * It is tracked separately from the preference rather than folded into a
   * single "current theme", so that switching to `dark` is one change of one
   * value and not a handover between two.
   */
  useEffect(() => {
    if (preference !== "system") return;
    if (typeof window.matchMedia !== "function") return;

    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystem(event.matches ? "dark" : "light");

    // The machine may have flipped while this tab was on an explicit choice.
    setSystem(query.matches ? "dark" : "light");

    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  const theme: ResolvedTheme = preference === "system" ? system : preference;

  // Separate from the state above so it runs for every route of this session,
  // including the ones the boot script never saw: client navigations do not
  // re-run a script in the head.
  //
  // Held until `ready`, because until then the value above is the server's
  // placeholder and the document is already correct — the boot script put the
  // reader's own palette there before the first paint. Writing to it in that
  // window would only ever overwrite a right answer with a provisional one.
  useEffect(() => {
    if (!ready) return;
    applyTheme(theme);
  }, [ready, theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeTheme(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, theme, setPreference }),
    [preference, theme, setPreference]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
