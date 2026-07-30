"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { shortAddress } from "@/lib/types";
import { ALERT } from "@/lib/walletTheme";

type Variant = "nav" | "block";

/**
 * The wallet control, drawn in Folio's print language instead of RainbowKit's
 * default rounded blue pill.
 *
 * `block` is the full-width slab used inside forms and the buy bar — same
 * geometry and weight as the Buy button it sits beside. `nav` is the compact
 * hairline chip in the masthead: once connected it splits into network and
 * account halves, each opening its own modal.
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

        return (
          <div
            aria-hidden={!ready}
            style={
              ready
                ? undefined
                : { opacity: 0, pointerEvents: "none", userSelect: "none" }
            }
          >
            {(() => {
              if (!connected) {
                return (
                  <PressButton variant={variant} onClick={openConnectModal}>
                    Connect wallet
                  </PressButton>
                );
              }

              if (chain.unsupported) {
                return (
                  <PressButton variant={variant} tone="alert" onClick={openChainModal}>
                    Wrong network
                  </PressButton>
                );
              }

              const who = account.ensName ?? shortAddress(account.address);

              if (variant === "block") {
                return (
                  // An address is not a label, so it keeps its own casing.
                  <PressButton variant="block" caps={false} onClick={openAccountModal}>
                    {who}
                    {account.displayBalance ? ` · ${account.displayBalance}` : ""}
                  </PressButton>
                );
              }

              return (
                <div style={{ display: "flex", border: "1px solid var(--ink)" }}>
                  <ChipHalf onClick={openChainModal}>{chain.name ?? "Network"}</ChipHalf>
                  <ChipHalf onClick={openAccountModal} caps={false} divided>
                    {who}
                  </ChipHalf>
                </div>
              );
            })()}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

function PressButton({
  variant,
  tone = "ink",
  caps = true,
  onClick,
  children,
}: {
  variant: Variant;
  tone?: "ink" | "alert";
  caps?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const alert = tone === "alert";
  const block = variant === "block";

  return (
    <button
      type="button"
      onClick={onClick}
      className="font-ui"
      style={{
        width: block ? "100%" : undefined,
        padding: block ? "14px 16px" : "7px 12px",
        background: block ? (alert ? ALERT : "var(--ink)") : "transparent",
        color: block ? "var(--paper)" : alert ? ALERT : "var(--ink)",
        border: block ? "none" : `1px solid ${alert ? ALERT : "var(--ink)"}`,
        fontSize: block ? 12 : 10,
        fontWeight: 600,
        letterSpacing: 1,
        textTransform: caps ? "uppercase" : "none",
        lineHeight: 1.2,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/** One half of the connected masthead chip. */
function ChipHalf({
  onClick,
  caps = true,
  divided,
  children,
}: {
  onClick?: () => void;
  caps?: boolean;
  divided?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-ui"
      style={{
        padding: "7px 10px",
        background: "transparent",
        color: "var(--ink)",
        border: "none",
        borderLeft: divided ? "1px solid var(--rule)" : "none",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 1,
        textTransform: caps ? "uppercase" : "none",
        lineHeight: 1.2,
        cursor: "pointer",
        maxWidth: 140,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}
