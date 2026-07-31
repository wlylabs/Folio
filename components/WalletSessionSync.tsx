"use client";

import { useEffect } from "react";
import { useConfig } from "wagmi";
import { getAccount, reconnect } from "wagmi/actions";
import { hasStoredWalletConnectSession } from "@/lib/walletSession";

/**
 * Adopt a wallet session that was approved while the page was not looking.
 *
 * Connecting a phone wallet means leaving the browser: Folio hands the wallet
 * app a pairing URI, the reader approves it there, and then comes back. wagmi
 * only tries to restore a session once, when the provider mounts, so an
 * approval that lands after that has no second chance — and a frozen tab is
 * exactly that case. The connector's socket is asleep when the session is
 * established, nothing wakes it, and the reader returns to a wallet reporting a
 * live connection and a Folio still offering "Connect wallet".
 *
 * So: each time the page comes back to the foreground with nothing connected
 * and a WalletConnect session in storage, ask wagmi to reconnect.
 *
 * Not once, but a handful of times across the first seconds back, because the
 * session is rarely in storage the instant the tab wakes. The wallet approves
 * over WalletConnect's relay, and the reply is delivered to a socket that has
 * just been resumed — or to a sign client that is still starting up, if the tab
 * was killed and the return is a fresh page load. A single attempt at wake-up
 * asks the one moment the answer is most likely to be "nothing here yet", and
 * then the reader sits in front of a Connect button with a live session behind
 * it until they reload. The schedule below covers that gap and stops as soon as
 * something connects.
 *
 * wagmi's own state is read through `getAccount` rather than `useAccount`: a
 * reconnect moves the status through "reconnecting" and back, and a component
 * that re-rendered on that would answer its own failure with another attempt,
 * forever.
 *
 * Renders nothing.
 */

/**
 * When to try, in milliseconds after the page comes back.
 *
 * Front-loaded — the common case is a session already waiting, which the first
 * attempt takes — then spaced out to cover a relay that is still catching up,
 * without turning a tab switch into a background job. An attempt with no stored
 * session costs one walk through localStorage and nothing else.
 */
const ADOPT_DELAYS_MS = [0, 800, 2_000, 4_000, 8_000];

export default function WalletSessionSync() {
  const config = useConfig();

  useEffect(() => {
    let timers: ReturnType<typeof setTimeout>[] = [];
    // A reconnect of ours is in flight. wagmi reports "reconnecting" for it
    // too, but only after the async work has started, and the first tick can
    // land inside that window.
    let running = false;

    const cancel = () => {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
    };

    const adopt = async () => {
      if (running) return;
      if (document.visibilityState !== "visible") return;

      const { status } = getAccount(config);
      // Connected: the trip is over, and the remaining attempts are noise.
      if (status === "connected") return cancel();
      // "connecting" is the reader's own attempt still running — RainbowKit
      // opened the wallet and is waiting on it — and "reconnecting" is wagmi
      // already doing this. Skip the tick, not the schedule: if either one
      // fails, a later tick still gets its turn.
      if (status !== "disconnected") return;
      // Keeps this off the path of a reader who never connected a wallet, who
      // would otherwise pay for a walk through every connector RainbowKit
      // registered on every tab switch.
      if (!hasStoredWalletConnectSession()) return;

      running = true;
      try {
        await reconnect(config);
      } catch {
        // A session that cannot be revived is answered by the Connect button,
        // which is already on screen.
      } finally {
        running = false;
      }
    };

    const schedule = () => {
      cancel();
      timers = ADOPT_DELAYS_MS.map((delay) =>
        setTimeout(() => {
          void adopt();
        }, delay)
      );
    };

    const onVisibilityChange = () => {
      // Leaving is the wallet app opening; nothing to adopt until it hands the
      // reader back, and the pending timers would only fire against a hidden
      // page.
      if (document.visibilityState === "hidden") cancel();
      else schedule();
    };

    // A restore from the back/forward cache fires no visibility change of its
    // own, so it needs its own listener.
    const onPageShow = () => schedule();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);

    // The return can also be a fresh page load — a phone that evicted the tab
    // reloads it on the way back, and that fires neither event.
    schedule();

    return () => {
      cancel();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [config]);

  return null;
}
