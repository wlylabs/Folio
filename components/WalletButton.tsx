"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { shortAddress } from "@/lib/types";
import { hasStoredWalletConnectSession } from "@/lib/walletSession";

type Variant = "menu" | "block";

/**
 * The wallet control, drawn in Folio's print language instead of RainbowKit's
 * default rounded blue pill.
 *
 * `block` is the full-width slab used inside forms and the trade panel — same
 * geometry and weight as the Buy button it sits beside. `menu` is the stacked
 * pair inside the settings panel: once connected it splits into a network row
 * and an account row, each opening its own modal, because the panel is where a
 * reader goes to change either one.
 *
 * `onOpenModal` fires just before a RainbowKit modal is asked to open. The
 * settings panel uses it to close itself first — a dropdown left standing
 * behind a modal is a second layer nobody asked for.
 */
export default function WalletButton({
  variant = "block",
  onOpenModal,
}: {
  variant?: Variant;
  onOpenModal?: () => void;
}) {
  const pending = useHandoffPending();

  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        // Wallet state is client-only, so the server render has nothing to show.
        // Hide it from assistive tech and pointer events rather than swapping
        // markup, which would shift the layout on hydration. The reveal is a
        // fade rather than a switch — see `.wallet-mount` in globals.css.
        const ready = mounted;
        const connected = ready && account && chain;
        const block = variant === "block";

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

              if (block) {
                return (
                  // An address is not a label, so it keeps its own casing.
                  <button
                    type="button"
                    onClick={open(openAccountModal)}
                    className="btn btn--block btn--outline btn--plain"
                  >
                    {who}
                    {account.displayBalance ? ` · ${account.displayBalance}` : ""}
                  </button>
                );
              }

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
