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
 * Deliberately one attempt per return, tracked by `armed` and re-armed when the
 * page is hidden again. wagmi's own state is read through `getAccount` rather
 * than `useAccount` for the same reason: reconnect moves the status through
 * "connecting" and back, and a component that re-rendered on that would answer
 * its own failure with another attempt, forever.
 *
 * Renders nothing.
 */
export default function WalletSessionSync() {
  const config = useConfig();

  useEffect(() => {
    let armed = true;

    const adopt = () => {
      if (!armed) return;
      if (document.visibilityState !== "visible") return;
      // "connecting" and "reconnecting" are wagmi already doing this.
      if (getAccount(config).status !== "disconnected") return;
      // Keeps this off the path of a reader who never connected a wallet, who
      // would otherwise pay for a walk through every connector RainbowKit
      // registered on every tab switch.
      if (!hasStoredWalletConnectSession()) return;

      armed = false;
      reconnect(config).catch(() => undefined);
    };

    const onVisibilityChange = () => {
      // Leaving re-arms for the trip back — this is the wallet app opening.
      if (document.visibilityState === "hidden") armed = true;
      else adopt();
    };

    // A restore from the back/forward cache fires no visibility change of its
    // own, so it needs its own listener.
    const onPageShow = () => {
      armed = true;
      adopt();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [config]);

  return null;
}
