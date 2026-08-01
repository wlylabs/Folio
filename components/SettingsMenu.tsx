"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useAccount } from "wagmi";
import WalletButton from "@/components/WalletButton";
import WalletHandoff from "@/components/WalletHandoff";
import CurrencySelector from "@/components/CurrencySelector";
import { FaucetDirectory } from "@/components/Faucet";
import { DEFAULT_CHAIN_SLUG, chainLabel } from "@/lib/chains";
import { FACTORY_DEPLOYMENTS } from "@/lib/contracts/deployment";
import { CONSENT_EVENT, readConsent, writeConsent, type ConsentChoice } from "@/lib/consent";
import { CONTACT_EMAIL } from "@/lib/contact";

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
  const { isConnected } = useAccount();
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
        onClick={() => setOpen((was) => !was)}
      >
        <span
          className={`settings__dot${isConnected ? " settings__dot--on" : ""}`}
          aria-hidden="true"
        />
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
            <WalletButton variant="menu" onOpenModal={close} />
            {!isConnected && (
              <p className="settings__note">
                Reading needs no wallet. Connect one to publish a launch or to
                trade from an article.
              </p>
            )}
            {/*
              The other way in, for a phone that cannot pair from a browser tab
              — including the case this panel used to describe in prose, a
              deployment with no WalletConnect project ID. It says the same
              thing and hands over a link that works. Renders nothing when the
              connect button is enough.
            */}
            <WalletHandoff />
          </section>

          <section className="settings__group">
            <h2 className="eyebrow">Display currency</h2>
            <CurrencySelector />
          </section>

          {/*
            The only place faucets are listed. Every action on Folio costs gas
            and a fresh wallet has none, so these links used to be reprinted at
            each point of failure — which on a phone meant a paragraph of them
            sitting on top of the article. One panel, every network, reachable
            from every page.
          */}
          <section className="settings__group">
            <h2 className="eyebrow">Test ETH</h2>
            <FaucetDirectory />
            <p className="settings__note">
              Folio runs on testnets, so gas is free — but it has to be claimed
              on the same network the token is on.
            </p>
          </section>

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
              Testnet edition ·{" "}
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
