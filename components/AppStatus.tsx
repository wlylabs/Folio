"use client";

import { useCallback, useEffect, useState } from "react";
import { captureInstallPrompt } from "@/lib/installPrompt";

/**
 * The two things the page has to say about itself, and the worker that makes
 * one of them possible.
 *
 * It renders nothing at all most of the time. When it does render, it is a
 * strip on the bottom edge saying one of:
 *
 *   "You're offline"    — because on a page that quotes prices, that is not a
 *                         detail. Every figure on screen is from before the
 *                         connection went, the trade buttons will fail, and a
 *                         reader deserves to know that before pressing one
 *                         rather than after.
 *   "A new edition"     — a service worker for a newer build is installed and
 *                         waiting. It is deliberately not applied by itself:
 *                         swapping the worker under a live page can hand it
 *                         assets from a build it was not rendered with, and
 *                         doing that to someone mid-transaction is unforgivable.
 *                         So the page asks, and the reader picks the moment.
 *
 * It is also where `beforeinstallprompt` is caught, because that has to happen
 * in something mounted for the life of the page — see lib/installPrompt.ts.
 * The offer surfaces in the settings panel, not here.
 */
export default function AppStatus() {
  const [offline, setOffline] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [reloading, setReloading] = useState(false);

  // The browser's offer to install, parked for the settings panel.
  useEffect(() => captureInstallPrompt(), []);

  /**
   * Connectivity.
   *
   * `navigator.onLine` is read in the effect rather than in the initial state
   * because the server has no answer for it, and a first render that disagreed
   * with the server's HTML is a hydration error. It is also a weak signal —
   * true means "there is an interface up", not "the internet is reachable" —
   * so this strip claims only what it can prove: false is reliable, and false
   * is the case worth reporting.
   */
  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();

    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    /*
     * Production only.
     *
     * In development the worker would sit between the page and the dev server,
     * answering with a cached build while webpack pushes updates the reader
     * never sees — the exact class of bug that takes an afternoon to trace back
     * to a service worker nobody remembered registering.
     */
    if (process.env.NODE_ENV !== "production") return;

    let cancelled = false;

    const watch = (registration: ServiceWorkerRegistration) => {
      if (cancelled) return;

      // Already waiting when the page loaded: the reader was here, left, and a
      // deploy happened in between.
      if (registration.waiting && navigator.serviceWorker.controller) {
        setWaiting(registration.waiting);
      }

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;

        installing.addEventListener("statechange", () => {
          // `controller` tells the two cases apart: with one, this is an
          // update to an existing install and the reader gets the offer. With
          // none, this is the very first install — nothing to replace, nothing
          // to announce.
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            setWaiting(installing);
          }
        });
      });
    };

    navigator.serviceWorker
      // `updateViaCache: "none"` so the browser always asks the network whether
      // sw.js has changed, rather than serving its own cached copy of the file
      // whose job is to decide what is cached.
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(watch)
      .catch((error) => {
        // Not fatal, and not worth a word to the reader: the site is the same
        // site without a worker. A blocked registration is ordinary — private
        // windows, an enterprise policy, storage turned off.
        console.warn("Folio's service worker did not register:", error);
      });

    // The new worker has taken over. Everything on screen was rendered by the
    // old build, so the page is replaced rather than left as a mix of the two.
    const onControllerChange = () => {
      if (cancelled) return;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (!waiting) return;
    setReloading(true);
    // The worker calls skipWaiting, takes control, and the listener above
    // reloads the page onto it.
    waiting.postMessage("SKIP_WAITING");
  }, [waiting]);

  if (offline) {
    return (
      <aside className="status-strip" role="status" aria-live="polite">
        <div className="status-strip__inner">
          <span className="status-strip__mark status-strip__mark--offline" aria-hidden="true" />
          <p className="status-strip__copy">
            <strong>You&rsquo;re offline.</strong> Prices, balances and trades
            all need a connection — everything on this page is from before it
            went.
          </p>
        </div>
      </aside>
    );
  }

  if (waiting) {
    return (
      <aside className="status-strip" role="status" aria-live="polite">
        <div className="status-strip__inner">
          <span className="status-strip__mark" aria-hidden="true" />
          <p className="status-strip__copy">
            <strong>A new edition of Folio is ready.</strong> It applies on the
            next reload.
          </p>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={applyUpdate}
            data-busy={reloading || undefined}
            disabled={reloading}
          >
            {reloading ? "Reloading…" : "Reload now"}
          </button>
        </div>
      </aside>
    );
  }

  return null;
}
