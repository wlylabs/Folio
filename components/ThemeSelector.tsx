"use client";

import { useTheme } from "@/components/ThemeProvider";
import { THEME_OPTIONS } from "@/lib/theme";

/**
 * Day, night, or whatever the machine says.
 *
 * Three chips rather than a switch, because there are three answers and a
 * two-state switch cannot hold the third — and the third is the default. A
 * reader who never touches this is on `System`, which is the only setting that
 * is right for both a phone at midnight and a desk at noon.
 *
 * The chips read as a group of toggles rather than as tabs: each one sets a
 * value, it does not switch a panel, so they carry `aria-pressed` like every
 * other chip in the interface. The note under them says which palette `System`
 * has landed on at the moment, since that is the one thing a reader looking at
 * this control cannot infer from the chip that is pressed.
 */
export default function ThemeSelector() {
  const { preference, theme, setPreference } = useTheme();

  return (
    <>
      <div className="chip-row" role="group" aria-label="Colour theme">
        {THEME_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className="chip"
            aria-pressed={preference === value}
            onClick={() => setPreference(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="settings__note">
        {preference === "system"
          ? `Following this device, which is set to ${theme === "dark" ? "night" : "day"} right now.`
          : "Held here on every page, until you change it."}{" "}
        Night keeps the same page — the paper goes dark and the ink goes light;
        gains stay green and losses red in both.
      </p>
    </>
  );
}
