"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  installPromptSnapshot,
  installPromptServerSnapshot,
  installsFromShareMenu,
  isStandalone,
  promptToInstall,
  subscribeToInstallPrompt,
} from "@/lib/installPrompt";

/**
 * Folio, on a home screen — offered where every other setting is offered.
 *
 * There is no banner and no interstitial for this anywhere in the app. An
 * install prompt that interrupts a reader is a worse advertisement for the app
 * than no app, and the browsers that do it best are the ones the reader can
 * ignore. So the offer waits in the settings panel until it is looked for.
 *
 * Three states, and each is a different browser rather than a different moment:
 *
 *  - Chrome and the rest of Chromium fire `beforeinstallprompt`, which
 *    lib/installPrompt.ts catches. There is a real button here.
 *  - Safari fires nothing, on any platform. On iOS the route is the Share menu,
 *    so the panel says which two taps rather than pretending it cannot be done.
 *  - Firefox on the desktop does not install web apps at all. Nothing is
 *    offered, because nothing can be.
 *
 * And when Folio is already the app the reader is looking at, this renders
 * nothing: there is no version of "install" worth saying to someone who has.
 */
export default function InstallControl() {
  const prompt = useSyncExternalStore(
    subscribeToInstallPrompt,
    installPromptSnapshot,
    installPromptServerSnapshot
  );

  /**
   * Both of these are answers only the browser has, so they are resolved in an
   * effect rather than during render — the server has no display mode and no
   * user agent to read, and a first render that assumed one would be a
   * hydration mismatch.
   */
  const [installed, setInstalled] = useState(false);
  const [shareMenu, setShareMenu] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());
    setShareMenu(installsFromShareMenu());
  }, []);

  const install = useCallback(async () => {
    const outcome = await promptToInstall();
    // "Not now" is an answer, and it is not one to re-ask on the same visit.
    // The browser offers a fresh event on a later one if the reader keeps
    // coming back, and the panel picks it up when it does.
    if (outcome === "dismissed") setDismissed(true);
  }, []);

  // Including the heading: a settings group titled "Home screen" with nothing
  // under it is worse than no group at all.
  if (installed) return null;

  return (
    <section className="settings__group">
      <h2 className="eyebrow">Home screen</h2>
      {prompt ? (
        <>
          <button type="button" className="btn btn--sm btn--outline" onClick={install}>
            Install Folio
          </button>
          <p className="settings__note">
            Opens in its own window, keeps its own place in the app switcher,
            and comes back to where it was after a wallet approval. It is the
            same site — nothing extra is installed and nothing new is
            collected.
          </p>
        </>
      ) : dismissed ? (
        <p className="settings__note">
          Not installed. The offer comes back on a later visit.
        </p>
      ) : shareMenu ? (
        <p className="settings__note">
          On iPhone and iPad: press <strong>Share</strong>, then{" "}
          <strong>Add to Home Screen</strong>. Folio then opens in its own
          window and comes back to where it was after a wallet approval.
        </p>
      ) : (
        <p className="settings__note">
          This browser doesn&rsquo;t install web apps. Folio works exactly the
          same in a tab — there is nothing in the installed copy that
          isn&rsquo;t here.
        </p>
      )}
    </section>
  );
}
