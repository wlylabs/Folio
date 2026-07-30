"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { shortAddress } from "@/lib/types";

type Variant = "nav" | "block";

/**
 * The wallet control, drawn in Folio's print language instead of RainbowKit's
 * default rounded blue pill.
 *
 * `block` is the full-width slab used inside forms and the trade dock — same
 * geometry and weight as the Buy button it sits beside. `nav` is the compact
 * hairline chip in the masthead: once connected it splits into network and
 * account halves, each opening its own modal, and the network half folds away
 * on a narrow phone where the address is the half worth keeping.
 */
export default function WalletButton({ variant = "block" }: { variant?: Variant }) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        // Wallet state is client-only, so the server render has nothing to show.
        // Hide it from assistive tech and pointer events rather than swapping
        // markup, which would shift the layout on hydration.
        const ready = mounted;
        const connected = ready && account && chain;
        const block = variant === "block";

        return (
          <div
            aria-hidden={!ready}
            style={
              ready
                ? block
                  ? { width: "100%" }
                  : undefined
                : { opacity: 0, pointerEvents: "none", userSelect: "none" }
            }
          >
            {(() => {
              if (!connected) {
                return (
                  <button
                    type="button"
                    onClick={openConnectModal}
                    className={buttonClass(variant, "outline")}
                  >
                    {/* "Connect wallet" wraps to two lines in the masthead on a
                        320px phone; in a form the full label has room. */}
                    {block ? "Connect wallet" : "Connect"}
                  </button>
                );
              }

              if (chain.unsupported) {
                return (
                  <button
                    type="button"
                    onClick={openChainModal}
                    className={buttonClass(variant, "alert")}
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
                    onClick={openAccountModal}
                    className="btn btn--block btn--outline btn--plain"
                  >
                    {who}
                    {account.displayBalance ? ` · ${account.displayBalance}` : ""}
                  </button>
                );
              }

              return (
                <div className="chip-group">
                  <button
                    type="button"
                    onClick={openChainModal}
                    className="chip-half chip-half--caps chip-half--optional"
                  >
                    {chain.name ?? "Network"}
                  </button>
                  <button
                    type="button"
                    onClick={openAccountModal}
                    className="chip-half chip-half--divided"
                  >
                    {who}
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

function buttonClass(variant: Variant, tone: "outline" | "alert"): string {
  const size = variant === "block" ? "btn--block" : "btn--sm";
  const skin = tone === "alert" ? "btn--alert" : "btn--outline";
  return `btn ${size} ${skin}`;
}
