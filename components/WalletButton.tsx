"use client";

import { ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { useEffect, useState } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { chainBySlug } from "@/lib/chains";
import { usePreferredChainSlug } from "@/lib/preferredChain";
import { shortAddress } from "@/lib/types";
import { useChainReach } from "@/lib/walletChainReach";
import { hasStoredWalletConnectSession } from "@/lib/walletSession";

/**
 * The wallet control, drawn in Folio's print language instead of RainbowKit's
 * default rounded blue pill.
 *
 * There is exactly one of these on the site, inside the settings panel. The
 * forms and the trade panel used to carry their own copy; a reader met the
 * connect button in three different shapes and had no single place that owned
 * the wallet. Now the panel owns it, and everywhere else says so in a line.
 *
 * Connected, it splits into a network row and an account row, each opening its
 * own modal, because the panel is where a reader goes to change either one.
 *
 * `onOpenModal` fires just before a RainbowKit modal is asked to open. The
 * settings panel uses it to close itself first — a dropdown left standing
 * behind a modal is a second layer nobody asked for.
 */
export default function WalletButton({ onOpenModal }: { onOpenModal?: () => void }) {
  const pending = useHandoffPending();
  const reach = useChainReach();
  const repair = useSessionRepair();
  const wanted = chainBySlug(usePreferredChainSlug())?.chain.name;

  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        // Wallet state is client-only, so the server render has nothing to show.
        // Hide it from assistive tech and pointer events rather than swapping
        // markup, which would shift the layout on hydration. The reveal is a
        // fade rather than a switch — see `.wallet-mount` in globals.css.
        const ready = mounted;
        const connected = ready && account && chain;

        // Every opener goes through here, so the panel closes on the way to any
        // modal without each call site remembering to do it.
        const open = (openModal: () => void) => () => {
          onOpenModal?.();
          openModal();
        };

        return (
          <div className="wallet-mount" aria-hidden={!ready}>
            {(() => {
              if (!connected) {
                // A wallet the page is still picking up gets the busy
                // treatment rather than a Connect button that lies about the
                // state — see useHandoffPending. It stays pressable, because a
                // handoff that never lands has to be escapable without a
                // reload.
                return (
                  <button
                    type="button"
                    onClick={open(openConnectModal)}
                    className="btn btn--block btn--outline"
                    data-busy={pending ? "true" : undefined}
                    aria-busy={pending || undefined}
                  >
                    {pending ? "Connecting…" : "Connect wallet"}
                  </button>
                );
              }

              if (chain.unsupported) {
                // A session that cannot carry a chain Folio supports has no
                // network to pick, so the chain modal is a door onto a wall.
                // Offer the one thing that changes the answer instead — see
                // lib/walletChainReach.ts.
                if (reach === "unreachable") {
                  return (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenModal?.();
                          repair();
                        }}
                        className="btn btn--block btn--alert"
                      >
                        Reconnect wallet
                      </button>
                      <p className="wallet-note">
                        Your wallet approved Folio on a network it doesn&apos;t use —
                        wallets open on Ethereum Mainnet, and the approval fixed the
                        connection there. Reconnecting asks for{" "}
                        {wanted ?? "the right network"} again. If your wallet still
                        won&apos;t offer it, turn on test networks in the wallet, or open
                        this page in the wallet&apos;s own browser.
                      </p>
                    </>
                  );
                }

                return (
                  <button
                    type="button"
                    onClick={open(openChainModal)}
                    className="btn btn--block btn--alert"
                  >
                    Wrong network
                  </button>
                );
              }

              const who = account.ensName ?? shortAddress(account.address);

              return (
                <div className="wallet-rows">
                  <button
                    type="button"
                    onClick={open(openChainModal)}
                    className="wallet-row"
                  >
                    <span className="wallet-row__label">Network</span>
                    <span className="wallet-row__value">{chain.name ?? "Unknown"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={open(openAccountModal)}
                    className="wallet-row"
                  >
                    <span className="wallet-row__label">Account</span>
                    {/* An address is not a label, so it keeps its own casing. */}
                    <span className="wallet-row__value wallet-row__value--plain">
                      {who}
                      {account.displayBalance ? ` · ${account.displayBalance}` : ""}
                    </span>
                  </button>
                </div>
              );
            })()}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

/**
 * Throw away a WalletConnect session that cannot reach a supported chain, and
 * ask for a new one.
 *
 * Both halves are needed, and in this order. Disconnecting is what clears the
 * session from storage: until it is gone, wagmi keeps adopting it on every page
 * load — it holds accounts, so it looks authorized — and the reader lands back
 * on the same wrong network without ever having asked to. Only then is a fresh
 * pairing proposed, and a fresh proposal is the only place the chains Folio
 * wants are named.
 *
 * The modal cannot be opened in the same breath: RainbowKit withholds
 * `openConnectModal` while a wallet is connected, so the call has to wait for
 * wagmi to report the disconnection. Hence the flag and the effect. If it is
 * still withheld by then, nothing opens and the button now reads "Connect
 * wallet" — one press behind, which is a worse outcome than intended and not a
 * broken one.
 */
function useSessionRepair(): () => void {
  const { disconnectAsync } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  const { status } = useAccount();
  const [reopen, setReopen] = useState(false);

  useEffect(() => {
    if (!reopen || status !== "disconnected") return;
    setReopen(false);
    openConnectModal?.();
  }, [reopen, status, openConnectModal]);

  return () => {
    setReopen(true);
    void disconnectAsync().catch(() => setReopen(false));
  };
}

/**
 * Is a connection being picked up right now, with nothing on screen to show for
 * it yet?
 *
 * The case this exists for is the walk back from a phone wallet. The approval
 * happened in another app, so wagmi has no connection of its own to replay —
 * only a WalletConnect session sitting in storage, which WalletSessionSync is
 * in the middle of adopting. Between the two, `account` is empty and the honest
 * label is not "Connect wallet": the reader just connected, and being asked to
 * do it again reads as a site that lost their approval.
 *
 * Two conditions, and both matter:
 *
 *  - "connecting" is always the reader's own press, so it always counts.
 *  - "reconnecting" is the status every page load starts in, including for
 *    somebody who has never owned a wallet. Showing them a spinning Connecting…
 *    on arrival would be a lie in the other direction, so it only counts when
 *    there is a stored session behind it.
 *
 * The storage read is deferred to an effect: it cannot run during SSR, and a
 * first client render that disagreed with the server's markup would be a
 * hydration mismatch. It re-runs on each status change, which is when a session
 * appears.
 */
function useHandoffPending(): boolean {
  const { status } = useAccount();
  const [stored, setStored] = useState(false);

  useEffect(() => {
    setStored(hasStoredWalletConnectSession());
  }, [status]);

  return status === "connecting" || (status === "reconnecting" && stored);
}
