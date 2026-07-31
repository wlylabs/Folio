"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { shortAddress } from "@/lib/types";

type Variant = "menu" | "block";

/**
 * The wallet control, drawn in Folio's print language instead of RainbowKit's
 * default rounded blue pill.
 *
 * `block` is the full-width slab used inside forms and the trade dock — same
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
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        // Wallet state is client-only, so the server render has nothing to show.
        // Hide it from assistive tech and pointer events rather than swapping
        // markup, which would shift the layout on hydration.
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
          <div
            aria-hidden={!ready}
            style={
              ready
                ? { width: "100%" }
                : { opacity: 0, pointerEvents: "none", userSelect: "none" }
            }
          >
            {(() => {
              if (!connected) {
                return (
                  <button
                    type="button"
                    onClick={open(openConnectModal)}
                    className="btn btn--block btn--outline"
                  >
                    Connect wallet
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
