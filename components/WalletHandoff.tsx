"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { hasWalletConnectProjectId, requiredChainName } from "@/lib/wagmiConfig";
import { currentPageLink, shouldOfferHandoff, walletAppLinks } from "@/lib/walletHandoff";

/**
 * The way in for a phone whose wallet will not connect from the browser.
 *
 * Pressing "Connect wallet" on a phone asks two apps and a relay to cooperate,
 * and when any of them declines the reader is told "not supported" by an app
 * that is not this one. Opening Folio inside the wallet's own browser skips all
 * of it: the page runs where the wallet already is. See lib/walletHandoff.ts.
 *
 * Shut by default and one line tall, because it is the second answer, not the
 * first — a reader whose wallet connects normally should never have to read
 * past the button. It hides itself entirely on a desktop with an extension, and
 * on any page opened inside a wallet browser, where the trip is already over.
 */
export default function WalletHandoff() {
  const { isConnected } = useAccount();
  const [open, setOpen] = useState(false);
  const [offer, setOffer] = useState(false);
  const [links, setLinks] = useState<{ id: string; name: string; href: string }[]>([]);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  // Both the decision and the links read the window, so neither can be part of
  // the server's render — an offer that appeared during SSR would be a
  // hydration mismatch on every desktop.
  useEffect(() => {
    setOffer(shouldOfferHandoff(hasWalletConnectProjectId));
    setLinks(walletAppLinks());
  }, []);

  if (isConnected || !offer || links.length === 0) return null;

  const copy = async () => {
    const link = currentPageLink();
    try {
      await navigator.clipboard.writeText(link);
      setCopied("done");
    } catch {
      // Clipboard access is refused outside a secure context and in some
      // in-app browsers. The address bar still holds the link, so say that
      // rather than failing silently.
      setCopied("failed");
    }
  };

  return (
    <div className="handoff">
      <button
        type="button"
        className="handoff__trigger"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {open ? "Hide wallet app options" : "Wallet not connecting?"}
      </button>

      {open && (
        <div className="handoff__panel">
          <p className="handoff__note">
            Open this page inside your wallet&apos;s own browser. The connection
            is made there, so nothing has to hand you back to this tab.
          </p>

          {requiredChainName && (
            // The likeliest reason a pairing was refused outright rather than
            // failing halfway, and the reader has no way to know it from the
            // wallet's own wording. Said here because this panel is where
            // somebody whose wallet said no ends up. See lib/wagmiConfig.ts.
            <p className="handoff__note">
              Folio asks wallets to approve {requiredChainName} when connecting, so a
              wallet without that network declines instead of connecting to the wrong
              one. Adding it — many wallets keep test networks behind a setting — fixes
              the pairing. Opening the page here skips the pairing altogether.
            </p>
          )}

          <div className="chip-row">
            {links.map((link) => (
              // A plain link, no target: these are universal links, and opening
              // one in a new tab is what stops a phone handing it to the app.
              <a key={link.id} className="chip chip--link" href={link.href} rel="noopener">
                {link.name}
              </a>
            ))}
            <button type="button" className="chip" onClick={() => void copy()}>
              {copied === "done"
                ? "Link copied"
                : copied === "failed"
                  ? "Copy from the address bar"
                  : "Copy link"}
            </button>
          </div>

          {!hasWalletConnectProjectId && (
            // Not a hint here but the whole story: with no project ID there is
            // no relay, so every phone wallet in the connect modal is unable to
            // pair no matter what the wallet says when it opens.
            <p className="handoff__note">
              This deployment has no WalletConnect project ID, so phone wallets
              can&apos;t be reached from a browser tab at all. Opening Folio in
              the wallet is the way in until{" "}
              <code>NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</code> is set.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
