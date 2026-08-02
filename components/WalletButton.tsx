"use client";

import { ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useDisconnect } from "wagmi";
import ConnectCue from "@/components/ConnectCue";
import { chainBySlug } from "@/lib/chains";
import { usePreferredChainSlug } from "@/lib/preferredChain";
import { shortAddress } from "@/lib/types";
import { WALLET_BOOT_MODAL, bootWallets } from "@/lib/walletBoot";
import { useChainReach } from "@/lib/walletChainReach";

/**
 * The wallet, as the settings panel shows it: which account, which network,
 * and the way out of every state that stops the reader.
 *
 * There is exactly one of these on the site. Asking for a wallet happens
 * wherever a reader was stopped — see ConnectCue, which this delegates its own
 * disconnected state to — but *showing* one belongs here, because the panel is
 * the single place that owns what the wallet currently is.
 *
 * Connected, it splits into a network row and an account row, each opening its
 * own modal, because the panel is where a reader goes to change either one.
 *
 * Every state that stops the reader carries a line saying what happened, in the
 * same place, in the same voice — a button labelled "Wrong network" is a
 * diagnosis without a fact behind it, and the reader has no way to learn from
 * the wallet which network Folio wanted.
 *
 * `onOpenModal` fires just before a RainbowKit modal is asked to open. The
 * settings panel uses it to close itself first — a dropdown left standing
 * behind a modal is a second layer nobody asked for.
 */
export default function WalletButton({ onOpenModal }: { onOpenModal?: () => void }) {
  const reach = useChainReach();
  const repair = useSessionRepair();
  const wanted = chainBySlug(usePreferredChainSlug())?.chain.name;

  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, mounted }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        // Every opener goes through here, so the panel closes on the way to any
        // modal without each call site remembering to do it — and so the last
        // of the wallet SDKs is released one tap before the entry that needs
        // it. See lib/walletBoot.ts.
        const open = (openModal: () => void) => () => {
          bootWallets(WALLET_BOOT_MODAL);
          onOpenModal?.();
          openModal();
        };

        return (
          <WalletMount ready={ready}>
            {(() => {
              // The disconnected state is not this component's to draw. It is
              // the same button, with the same label and the same three states,
              // that a reader meets at the trade panel and the launch form —
              // and it is one component so that it stays that way. See
              // ConnectCue.
              if (!connected) return <ConnectCue onOpenModal={onOpenModal} />;

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
                          bootWallets(WALLET_BOOT_MODAL);
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
                  <>
                    <button
                      type="button"
                      onClick={open(openChainModal)}
                      className="btn btn--block btn--alert"
                    >
                      Wrong network
                    </button>
                    {/* Both halves of the mismatch, because the wallet reports
                        neither: it does not know what Folio wanted, and the
                        button on its own does not say where the reader
                        actually is. */}
                    <p className="wallet-note">
                      Your wallet is on {chainName(chain)}. Folio trades on{" "}
                      {wanted ?? "another network"} — press the button to switch.
                    </p>
                  </>
                );
              }

              const who = account.ensName ?? shortAddress(account.address);

              return (
                <div className="wallet-rows">
                  <button
                    type="button"
                    onClick={open(openChainModal)}
                    className="wallet-row"
                    // The visible pair reads as a fact rather than a control,
                    // so the name says what pressing it does. Screen readers
                    // announce this in place of the two spans.
                    aria-label={`Network: ${chain.name ?? "unknown"}. Change network`}
                  >
                    <span className="wallet-row__label">Network</span>
                    <span className="wallet-row__value">{chain.name ?? "Unknown"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={open(openAccountModal)}
                    className="wallet-row"
                    aria-label={`Account: ${who}. Open account details`}
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
          </WalletMount>
        );
      }}
    </ConnectButton.Custom>
  );
}

/**
 * The networks a reader is most likely to be parked on when Folio says wrong
 * one, by the names their wallet shows them.
 *
 * RainbowKit reports an unsupported chain by id alone — the name lives in the
 * config the chain is by definition not in — and "your wallet is on chain 1" is
 * a sentence about a database. These are the handful of ids worth spelling: the
 * mainnet every wallet opens on, and the four L2s a reader who has been
 * anywhere else will be sitting on. Anything not here still prints its id,
 * which is at least checkable against the wallet.
 *
 * Not read from viem/chains, which would import a few hundred chain definitions
 * to print one string.
 */
const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum Mainnet",
  10: "OP Mainnet",
  56: "BNB Smart Chain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
};

function chainName(chain: { name?: string; id: number }): string {
  return chain.name ?? CHAIN_NAMES[chain.id] ?? `chain ${chain.id}`;
}

/**
 * The frame the wallet control lives in, held out of reach until it means
 * something.
 *
 * Wallet state is client-only, so the server render has nothing to show. Rather
 * than swapping markup — which would shift the layout on hydration — the frame
 * is drawn at zero opacity and faded in; see `.wallet-mount` in globals.css.
 *
 * Which leaves a button that is invisible, unclickable, and still in the tab
 * order: `aria-hidden` and `pointer-events: none` say nothing to a keyboard.
 * `inert` is the one property that covers all three, and it is set from an
 * effect rather than written as a prop because React 18 has no boolean handling
 * for it. A browser too old to know the word keeps the behaviour this had
 * before, which is the safe direction for it to be wrong in.
 */
function WalletMount({ ready, children }: { ready: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.inert = !ready;
  }, [ready]);

  return (
    <div ref={ref} className="wallet-mount" aria-hidden={!ready}>
      {children}
    </div>
  );
}

/** How long a repair keeps waiting for RainbowKit to hand back an opener
 *  before it stops expecting one. */
const REPAIR_DEADLINE_MS = 5_000;

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
 * wagmi to report the disconnection. Hence the flag and the effect.
 *
 * And the wait is for the opener, not merely for the status. Those arrive in
 * either order — the disconnection can be reported a render before RainbowKit
 * hands the opener back — so a single look at the first disconnected render
 * used to find nothing there and disarm, leaving the reader one press behind
 * with a button that had just torn down their session. It stays armed until
 * there is something to open, and gives up after a deadline rather than
 * ambushing them with a modal a minute later.
 */
function useSessionRepair(): () => void {
  const { disconnectAsync } = useDisconnect();
  const { openConnectModal } = useConnectModal();
  const { status } = useAccount();
  const [reopen, setReopen] = useState(false);

  useEffect(() => {
    if (!reopen || status !== "disconnected") return;

    if (openConnectModal) {
      setReopen(false);
      openConnectModal();
      return;
    }

    const timer = setTimeout(() => setReopen(false), REPAIR_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [reopen, status, openConnectModal]);

  return () => {
    setReopen(true);
    void disconnectAsync().catch(() => setReopen(false));
  };
}
