"use client";

import { useCallback } from "react";
import { useAccountEffect, useConfig } from "wagmi";
import { forgetWalletChoice } from "@/lib/walletChoice";
import { forgetCreatorSession } from "@/lib/walletAuth";

/**
 * Put the connect modal back to its default state when a wallet goes away.
 *
 * A reader who disconnects is told, by three different libraries, that they are
 * still a WalletConnect reader: the modal reopens with that entry hoisted to the
 * top under a "Recent" badge, and on a phone the next pairing deep links
 * straight back into the app they just left. lib/walletChoice.ts says what each
 * note is and why none of it should survive; this is where the moment is
 * noticed.
 *
 * That moment is wagmi's, not RainbowKit's. Folio does not own the Disconnect
 * button — it lives inside RainbowKit's account modal — and it is not the only
 * way a wallet goes away: a reader can disconnect from inside the wallet app,
 * and `useSessionRepair` in components/WalletButton.tsx tears a session down on
 * purpose to ask for a better one. `useAccountEffect` sees all three, because it
 * watches the account rather than any button, and it fires only on the
 * connected → disconnected edge. A reconnect that simply fails — the reader
 * reloading with the wallet app closed — is not a disconnection and leaves the
 * notes where they are, which is right: they never chose to leave.
 *
 * Renders nothing.
 */
export default function WalletChoiceReset() {
  const config = useConfig();

  const onDisconnect = useCallback(() => {
    forgetWalletChoice();

    // The sign-in that proved the last wallet's address goes with the wallet.
    // It is scoped to that address and would be refused for any other, so
    // keeping it would only ever mean one stale token sitting in a tab — and a
    // reader who disconnects has said what they want done with it.
    forgetCreatorSession();

    // wagmi's own note, which it keeps through a disconnect — it only ever
    // overwrites it, with whichever connection is left, and a full disconnect
    // leaves none. Removed through the config rather than by key because wagmi
    // owns the prefix, and asynchronously because a storage adapter is allowed
    // to be. Nothing waits on it: it is read at the next mount, not this one.
    void Promise.resolve(config.storage?.removeItem("recentConnectorId")).catch(
      () => undefined
    );
  }, [config]);

  useAccountEffect({ onDisconnect });

  return null;
}
