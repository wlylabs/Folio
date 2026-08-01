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
  resolveTheme,
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
 * Three things can change the answer afterwards, and all three are listened
 * for: the panel in this tab, the same panel in another tab, and the operating
 * system flipping under a reader who is on `system`.
 */
export default function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME);
  const [theme, setTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const stored = readTheme() ?? DEFAULT_THEME;
    setPreferenceState(stored);
    setTheme(resolveTheme(stored));
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
   * The system's answer, while the reader is deferring to it.
   *
   * Only subscribed on `system` — a reader who has explicitly asked for the
   * light page should not have it go dark at sunset because their laptop does.
   */
  useEffect(() => {
    if (preference !== "system") {
      setTheme(preference);
      return;
    }

    setTheme(systemTheme());

    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setTheme(event.matches ? "dark" : "light");

    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  // Separate from the state above so it runs for every route of this session,
  // including the ones the boot script never saw: client navigations do not
  // re-run a script in the head.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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
