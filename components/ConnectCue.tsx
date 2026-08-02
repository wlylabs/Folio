"use client";

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { WALLET_BOOT_MODAL, bootWallets } from "@/lib/walletBoot";
import { useConnectPhase } from "@/lib/walletPhase";

/**
 * The one connect control on the site, wherever a reader meets it.
 *
 * ---------------------------------------------------------------------------
 * Why this exists, given that the settings panel owns the wallet
 * ---------------------------------------------------------------------------
 *
 * It still does. The panel is the only place that *shows* a wallet — which
 * account, which network, and the two modals that change either. What it
 * stopped being is the only place a wallet can be *asked for*.
 *
 * Four places used to print a sentence instead: "Connect a wallet under
 * Settings in the masthead to trade." Three problems with that, in rising
 * order of seriousness.
 *
 * It is prose describing the location of a control, so it is wrong the day the
 * masthead changes, in four files at once, silently.
 *
 * It is four gestures where there was one. The trade panel is at the bottom of
 * a phone and the masthead is at the top, so a reader who has just decided to
 * buy scrolls up, opens a panel, finds the wallet section, presses, and comes
 * back down to a form they have to fill in again from memory.
 *
 * And it gives the wallet layer nothing to listen to. The SDKs are not built
 * until somebody looks like they are heading for one, and the only signal for
 * that used to be the settings button — see lib/walletBoot.ts. A reader who
 * landed straight on a token article and pressed nothing in the masthead paid
 * for the whole download at the moment of the press. A real button has a
 * pointer arriving at it, which is a beat earlier and free.
 *
 * The thing the panel was protecting against — a reader meeting the connect
 * button in three different shapes — is answered by this being one component
 * with one label and one set of states, used verbatim by the panel itself. Not
 * by there being one location.
 *
 * ---------------------------------------------------------------------------
 * What it draws
 * ---------------------------------------------------------------------------
 *
 * Nothing, once a wallet is attached: every call site renders it in the slot
 * that was going to be empty anyway. Otherwise the same outline button in every
 * one of them, carrying the three states of useConnectPhase — an offer, a
 * connection being picked up, and a connection that has stopped answering.
 *
 * `onOpenModal` fires just before the connect modal is asked to open. The
 * settings panel uses it to close itself first; nowhere else needs it.
 */
export default function ConnectCue({ onOpenModal }: { onOpenModal?: () => void }) {
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const phase = useConnectPhase();

  // `isConnected` is already true while wagmi revives a stored session, which
  // is a wallet on its way in rather than one to ask for. RainbowKit withholds
  // the opener in both cases, and without it there is no button to draw.
  if (isConnected || !openConnectModal) return null;

  const waiting = phase === "waiting";

  return (
    <>
      <button
        type="button"
        onClick={() => {
          bootWallets(WALLET_BOOT_MODAL);
          onOpenModal?.();
          openConnectModal();
        }}
        /*
         * The modal's own connectors, released a beat before the press rather
         * than by it — the half a megabyte behind WalletConnect's own modal,
         * fetched while the pointer is still travelling. Three events because
         * they cover three readers and the earliest one wins: a pointer resting
         * here, a keyboard reaching here, and a finger on a phone that has no
         * hover to offer.
         */
        onPointerEnter={() => bootWallets(WALLET_BOOT_MODAL)}
        onFocus={() => bootWallets(WALLET_BOOT_MODAL)}
        onPointerDown={() => bootWallets(WALLET_BOOT_MODAL)}
        className="btn btn--block btn--outline"
        // A wallet the page is still picking up gets the busy treatment rather
        // than a Connect button that lies about the state. It stays pressable
        // throughout, because a handoff that never lands has to be escapable
        // without a reload.
        data-busy={waiting ? "true" : undefined}
        aria-busy={waiting || undefined}
      >
        {waiting ? "Connecting…" : "Connect wallet"}
      </button>

      {phase === "stalled" && (
        // Said out loud, and announced: a reader who has been watching
        // "Connecting…" for twenty seconds is the one person on the site who is
        // definitely still looking at this button.
        <p className="wallet-note" role="status">
          Your wallet hasn&apos;t answered yet. If you approved the connection in
          another app, come back to this tab and it will catch up on its own. If
          nothing opened, press Connect wallet again.
        </p>
      )}
    </>
  );
}
