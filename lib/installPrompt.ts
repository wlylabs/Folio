/**
 * The browser's offer to install Folio, held until the reader asks for it.
 *
 * Chrome fires `beforeinstallprompt` early — usually within a second of the
 * first paint — and the event is only useful if it was caught: call
 * `preventDefault()` on it and the browser's own install chip goes away, leaving
 * whatever the page offers instead. That is the trade this module makes, and it
 * is worth being deliberate about, because the alternative is a page that
 * interrupts a reader who came to read with a modal about a home screen.
 *
 * So: the event is caught once, in the component that is always mounted, and
 * parked here. The settings panel — which is where every other thing the reader
 * can decide already lives — asks whether there is one and shows a button when
 * there is. Nothing pops up, nothing is dismissed, and a reader who never opens
 * the panel is never asked.
 *
 * Safari fires no such event at all, on any platform. There an installed copy
 * comes from the Share menu, so the panel says so in words instead.
 */

/** The shape of `beforeinstallprompt`, which is in no standard lib.dom. */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export type InstallOutcome = "accepted" | "dismissed" | "unavailable";

let captured: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Start listening for the browser's offer. Returns the teardown, so a component
 * effect can hand it straight back.
 *
 * Called from exactly one place — components/AppStatus.tsx, which is mounted
 * for the life of the page. Calling it twice would catch the same event twice,
 * which is harmless but pointless.
 */
export function captureInstallPrompt(): () => void {
  const onBeforeInstall = (event: Event) => {
    // Without this the browser shows its own affordance, and a reader gets
    // asked about installing by the chrome while reading an article.
    event.preventDefault();
    captured = event as InstallPromptEvent;
    announce();
  };

  // Installed. The offer is spent, and the panel should stop offering it —
  // including in the tab the reader installed from, which stays open.
  const onInstalled = () => {
    captured = null;
    announce();
  };

  window.addEventListener("beforeinstallprompt", onBeforeInstall);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

/** For `useSyncExternalStore`: the current offer, or null. */
export function installPromptSnapshot(): InstallPromptEvent | null {
  return captured;
}

/** For `useSyncExternalStore` on the server, where there is never an offer. */
export function installPromptServerSnapshot(): null {
  return null;
}

export function subscribeToInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Show the browser's install dialog and wait for the answer.
 *
 * The event is single-use whichever way it is answered — a dismissed prompt
 * cannot be shown again from the same event — so it is dropped either way and
 * the button disappears with it. Chrome fires a fresh one later if the reader
 * keeps coming back.
 */
export async function promptToInstall(): Promise<InstallOutcome> {
  const event = captured;
  if (!event) return "unavailable";

  captured = null;
  announce();

  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  } catch {
    return "unavailable";
  }
}

/** Whether this page is already running as an installed app rather than in a
 *  tab. `standalone` is Safari's own flag; the media query is everyone else. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;

  const iosInstalled = (window.navigator as { standalone?: boolean }).standalone === true;
  return (
    iosInstalled ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches)
  );
}

/**
 * Whether this is a browser that installs from the Share menu rather than from
 * an event — every browser on iOS and iPadOS, which are all WebKit underneath.
 *
 * An iPad reports itself as a Mac and gives itself away with a touch screen,
 * which is the check below. It is a heuristic, and it is only ever used to
 * decide whether to print a sentence of instructions, so being wrong costs a
 * reader one line of text they did not need.
 */
export function installsFromShareMenu(): boolean {
  if (typeof navigator === "undefined") return false;

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return ios || iPadOS;
}
