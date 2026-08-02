"use client";

import { ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { chainBySlug } from "@/lib/chains";
import { usePreferredChainSlug } from "@/lib/preferredChain";
import { shortAddress } from "@/lib/types";
import { WALLET_BOOT_MODAL, bootWallets } from "@/lib/walletBoot";
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
  const phase = useConnectPhase();
  const reach = useChainReach();
  const repair = useSessionRepair();
  const wanted = chainBySlug(usePreferredChainSlug())?.chain.name;

  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
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
              if (!connected) {
                // A wallet the page is still picking up gets the busy
                // treatment rather than a Connect button that lies about the
                // state — see useConnectPhase. It stays pressable throughout,
                // because a handoff that never lands has to be escapable
                // without a reload.
                const waiting = phase === "waiting";
                return (
                  <>
                    <button
                      type="button"
                      onClick={open(openConnectModal)}
                      /*
                       * The modal's own connectors, released a beat before the
                       * press rather than by it. The settings trigger already
                       * released the wallets this modal lists (see
                       * SettingsMenu); this releases the last one, the half a
                       * megabyte behind WalletConnect's own modal, at the
                       * moment the reader reaches for the button rather than at
                       * the moment they press it.
                       */
                      onPointerEnter={() => bootWallets(WALLET_BOOT_MODAL)}
                      onFocus={() => bootWallets(WALLET_BOOT_MODAL)}
                      className="btn btn--block btn--outline"
                      data-busy={waiting ? "true" : undefined}
                      aria-busy={waiting || undefined}
                    >
                      {waiting ? "Connecting…" : "Connect wallet"}
                    </button>
                    {phase === "stalled" && (
                      // Said out loud, and announced: a reader who has been
                      // watching "Connecting…" for twenty seconds is the one
                      // person on the site who is definitely still looking at
                      // this button.
                      <p className="wallet-note" role="status">
                        Your wallet hasn&apos;t answered yet. If you approved the
                        connection in another app, come back to this tab and it will
                        catch up on its own. If nothing opened, press Connect wallet
                        again.
                      </p>
                    )}
                  </>
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

/**
 * How long a reader watches "Connecting…" before the page admits it has no
 * news.
 *
 * Counted in foreground time only — see below. Long enough to cover the whole
 * of WalletSessionSync's adoption schedule, which runs to eight seconds after
 * the return, plus room for a relay that is catching up behind it.
 */
const STALL_AFTER_MS = 20_000;

type ConnectPhase =
  /** Nothing in flight: the button is an offer. */
  | "idle"
  /** A connection is being picked up, with nothing on screen to show for it. */
  | "waiting"
  /** Still nothing, long enough that silence is now the more likely story. */
  | "stalled";

/**
 * What the connect button is in the middle of, if anything.
 *
 * The case this exists for is the walk back from a phone wallet. The approval
 * happened in another app, so wagmi has no connection of its own to replay —
 * only a WalletConnect session sitting in storage, which WalletSessionSync is
 * in the middle of adopting. Between the two, `account` is empty and the honest
 * label is not "Connect wallet": the reader just connected, and being asked to
 * do it again reads as a site that lost their approval.
 *
 * Two conditions decide that, and both matter:
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
 *
 * "stalled" is the third state, and it is the one the button used to be missing.
 * Nothing times a connect out: a pairing the wallet never answers, an approval
 * that went to a relay and stopped there, an app that never handed the reader
 * back — all of them leave wagmi reporting "connecting" indefinitely, and the
 * button swept a progress bar under the word Connecting… for as long as the
 * reader was willing to watch it. That is the same lie as the first one, told
 * slowly. So after a while the button goes back to being an offer they can
 * press, and a line underneath says what is and isn't known.
 *
 * The clock runs on foreground time and restarts every time the page comes
 * back, because the minutes spent inside the wallet app are not the reader
 * waiting on Folio — they are the reader doing the thing Folio asked for. It is
 * the wait *here*, uninterrupted, that means nothing is coming.
 */
function useConnectPhase(): ConnectPhase {
  const { status } = useAccount();
  const [stored, setStored] = useState(false);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    setStored(hasStoredWalletConnectSession());
  }, [status]);

  const pending = status === "connecting" || (status === "reconnecting" && stored);

  useEffect(() => {
    if (!pending) {
      setStalled(false);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
      if (timer) clearTimeout(timer);
      setStalled(false);
      timer = setTimeout(() => setStalled(true), STALL_AFTER_MS);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else if (timer) clearTimeout(timer);
    };

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [pending]);

  if (!pending) return "idle";
  return stalled ? "stalled" : "waiting";
}
