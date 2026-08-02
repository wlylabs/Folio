"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAccount } from "wagmi";
import WalletButton from "@/components/WalletButton";
import CurrencySelector from "@/components/CurrencySelector";
import ThemeSelector from "@/components/ThemeSelector";
import InstallControl from "@/components/InstallControl";
import { DEFAULT_CHAIN_SLUG, chainLabel, isSupportedChainId } from "@/lib/chains";
import { FACTORY_DEPLOYMENTS } from "@/lib/contracts/deployment";
import { CONSENT_EVENT, readConsent, writeConsent, type ConsentChoice } from "@/lib/consent";
import { CONTACT_EMAIL } from "@/lib/contact";
import { bootWallets } from "@/lib/walletBoot";

/**
 * What the masthead says about the wallet, before the panel is opened.
 *
 * Three states rather than two. A wallet parked on a network Folio does not
 * support is connected in every sense wagmi cares about and useless in every
 * sense the reader does — it cannot buy, sell or launch anything — so a dot
 * that filled in for it was announcing a readiness that wasn't there, and the
 * reader found out at the trade button instead. The needs-attention state is
 * the one the panel can actually fix, which is the whole reason to draw it
 * where the panel's own button is.
 */
type WalletState = "none" | "ready" | "attention";

function walletState(isConnected: boolean, chainId: number | undefined): WalletState {
  if (!isConnected) return "none";
  return isSupportedChainId(chainId) ? "ready" : "attention";
}

const WALLET_STATE_LABEL: Record<WalletState, string> = {
  none: "no wallet connected",
  ready: "wallet connected",
  attention: "wallet on an unsupported network",
};

/**
 * Everything the reader can set, in one place behind one button.
 *
 * The masthead used to carry the wallet chip and the currency toggle side by
 * side, which put two unrelated controls — one that signs transactions, one
 * that formats a second line under a price — at the same weight as the
 * navigation. They are both settings, so they live in the settings panel, and
 * the masthead is left with the wordmark and the reader's own page.
 *
 * The panel closes on Escape, on a click outside it, and on a navigation, and
 * hands focus back to the trigger when Escape closed it. It also closes on the
 * way into any RainbowKit modal — see WalletButton's `onOpenModal`.
 */
export default function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const { isConnected, chainId } = useAccount();
  const wallet = walletState(isConnected, chainId);
  const pathname = usePathname();
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // A link inside the panel navigates; the panel should not follow the reader
  // to the page it sent them to.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Escape is a keyboard dismissal, so focus goes back where it came from.
      triggerRef.current?.focus();
    };

    // pointerdown rather than click: a reader who presses outside the panel has
    // already decided to dismiss it, and waiting for mouseup leaves the panel
    // standing under their cursor.
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="settings" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn--sm btn--outline"
        aria-expanded={open}
        aria-controls={panelId}
        /*
         * The dot is decoration, so the state it carries has to reach a screen
         * reader some other way. All three states, not only the interesting
         * ones: a name that appears when something is wrong and vanishes when
         * it isn't is a name that cannot be trusted to mean anything. The
         * visible word stays first in it, so "click Settings" still works for
         * anyone driving by voice.
         */
        aria-label={`Settings — ${WALLET_STATE_LABEL[wallet]}`}
        /*
         * The wallet SDKs are not downloaded until somebody looks like they
         * are heading for them — see lib/walletBoot.ts. Three events rather
         * than one because they cover three different readers and the earliest
         * one wins: a pointer resting on the button, a keyboard reaching it,
         * and a finger pressing it on a phone that has no hover to offer. All
         * three land before the press of "Connect wallet" inside the panel,
         * which is the press that used to pay for this.
         *
         * Not the only door any more: ConnectCue releases the same work when a
         * reader reaches for a connect button somewhere else, which is the
         * route somebody who arrived straight at a token article takes.
         */
        onPointerEnter={() => bootWallets()}
        onFocus={() => bootWallets()}
        onPointerDown={() => bootWallets()}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={`settings__dot settings__dot--${wallet}`} aria-hidden="true" />
        Settings
      </button>

      {open && (
        <div
          id={panelId}
          className="settings__panel"
          role="dialog"
          aria-label="Settings"
        >
          <section className="settings__group">
            <h2 className="eyebrow">Wallet</h2>
            <WalletButton onOpenModal={close} />
            {!isConnected && (
              <p className="settings__note">
                Reading needs no wallet. Connect one to publish a launch or to
                trade from an article.
              </p>
            )}
          </section>

          <section className="settings__group">
            <h2 className="eyebrow">Appearance</h2>
            <ThemeSelector />
          </section>

          <section className="settings__group">
            <h2 className="eyebrow">Display currency</h2>
            <CurrencySelector />
          </section>

          {/* The offer to install, in the one place a reader goes looking for
              things they can decide. It brings its own heading, because it
              renders nothing at all — heading included — once Folio is the app
              they are already in. */}
          <InstallControl />

          {/*
            No faucet section, and there should not be one. This panel used to
            list the test networks that handed out free ETH; Folio runs on
            Robinhood Chain alone now, where gas is real ETH the reader already
            holds. Nothing here can give it away, and anything that offers to is
            not a faucet.
          */}
          <section className="settings__group">
            <h2 className="eyebrow">Cookies</h2>
            <ConsentControl />
          </section>

          <section className="settings__group">
            <h2 className="eyebrow">About Folio</h2>
            <p className="settings__note">
              A launchpad where the listing is the article. Every token is
              minted onto a bonding curve that quotes both sides of the trade
              from the page itself.
            </p>
            <nav className="settings__links" aria-label="About Folio">
              <Link href="/about">About Folio</Link>
              <Link href="/create">Launch a token</Link>
              <Link href="/terms">Terms</Link>
              <Link href="/privacy">Privacy</Link>
              {/* Plain <a>: next/link is for routes, and this leaves the site. */}
              <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
            </nav>
            <p className="settings__meta">
              Launching on{" "}
              {FACTORY_DEPLOYMENTS.length > 1
                ? FACTORY_DEPLOYMENTS.map((d) => chainLabel(d.chain)).join(" · ")
                : chainLabel(FACTORY_DEPLOYMENTS[0]?.chain ?? DEFAULT_CHAIN_SLUG)}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * The answer to the consent banner, after the banner is gone.
 *
 * The banner asks once and never returns; a reader who wants to change their
 * mind a week later had nowhere to do it. Same two answers, same storage, so
 * whichever one they used last is the one that holds.
 *
 * `undefined` until the effect runs — localStorage cannot be read during SSR,
 * and pressing a chip on the server render would be a hydration mismatch.
 */
function ConsentControl() {
  const [choice, setChoice] = useState<ConsentChoice | undefined>(undefined);

  useEffect(() => {
    const sync = () => setChoice(readConsent()?.value);
    sync();

    // The banner writes the same key. If it is still on screen behind the
    // panel, an answer there has to show up here.
    window.addEventListener(CONSENT_EVENT, sync);
    return () => window.removeEventListener(CONSENT_EVENT, sync);
  }, []);

  function choose(value: ConsentChoice) {
    writeConsent(value);
    setChoice(value);
  }

  return (
    <>
      <div className="chip-row" role="group" aria-label="Cookie preferences">
        <button
          type="button"
          className="chip"
          aria-pressed={choice === "declined"}
          onClick={() => choose("declined")}
        >
          Essential only
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={choice === "accepted"}
          onClick={() => choose("accepted")}
        >
          Accept
        </button>
      </div>

      <p className="settings__note">
        Folio keeps what it needs to work — the wallet you connected, nothing
        more. Optional analytics stay off unless you allow them.{" "}
        <Link href="/privacy">Read the privacy policy</Link>.
      </p>
    </>
  );
}
