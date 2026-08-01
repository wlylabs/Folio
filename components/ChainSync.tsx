"use client";

import { useEffect, useRef } from "react";
import { useAccount, useConfig } from "wagmi";
import { switchChain } from "wagmi/actions";
import { chainBySlug, isSupportedChainId } from "@/lib/chains";
import { usePreferredChainSlug } from "@/lib/preferredChain";
import { setChainReach } from "@/lib/walletChainReach";
import { walletConnectChainIds } from "@/lib/walletSession";

/**
 * Move a wallet that landed on a chain Folio cannot use — and when it will not
 * move, work out why and say so.
 *
 * Wallets open on Ethereum mainnet, and most readers have never changed that,
 * so the first thing a fresh connection produced was "Wrong network" — a
 * correct label for a state the reader did nothing to cause and has no obvious
 * way out of. RainbowKit's `initialChain` asks for the right chain as part of
 * the connect call itself, which covers the press; this covers everything else
 * that arrives on an unsupported chain — a session restored from storage, a
 * phone wallet adopted after the fact by WalletSessionSync, a wallet the reader
 * switched away from in another tab.
 *
 * Only unsupported chains. A wallet sitting on a supported chain that is not
 * the one the page's token lives on is a *different* problem, one the trade bar
 * solves at the right moment: it switches when there is a transaction to sign,
 * so reading a page never moves a wallet the reader deliberately put somewhere.
 * With Robinhood Chain the only supported network that case cannot arise today,
 * and the trade bar's switch is what would handle it if a second one returned.
 *
 * One request per situation. wagmi's switchChain adds the chain to the wallet
 * when it does not have it (`wallet_addEthereumChain`), but either half can be
 * declined, and a prompt that reappears every time it is dismissed is worse
 * than the wrong-network button it was trying to save the reader from. So a
 * refusal is final until something actually changes — a different wallet, a
 * different account, a different chain to leave or to aim at — and the manual
 * escape stays where it was, in the connect button.
 *
 * Renders nothing.
 */

/**
 * How long to wait for a switch before calling it failed.
 *
 * Not belt and braces: wagmi's WalletConnect `switchChain` resolves on a race
 * between the RPC reply and a `chainChanged` event carrying the new id, and a
 * wallet asked for a chain outside its session's namespaces can answer neither
 * — it has nothing valid to emit. That promise then never settles, so without a
 * clock here the failure is invisible, and the reader sits in front of a button
 * that is waiting for something that is not coming. A late success is still
 * picked up: the chain id changes, this effect runs again, and finds itself
 * somewhere supported.
 */
const SWITCH_TIMEOUT_MS = 20_000;

export default function ChainSync() {
  const config = useConfig();
  const { address, chainId, connector, status } = useAccount();
  const target = chainBySlug(usePreferredChainSlug())?.chain.id;

  // The last situation a switch was requested for, so a decline is not asked
  // about again. A ref, not state: it must not itself cause a render.
  const asked = useRef<string | null>(null);

  useEffect(() => {
    // Nothing connected, or nowhere to aim: whatever the last session could not
    // reach is not in front of the reader any more.
    if (status !== "connected" || target === undefined) {
      setChainReach("ok");
      return;
    }
    // Already somewhere Folio can work.
    if (isSupportedChainId(chainId)) {
      setChainReach("ok");
      return;
    }

    const situation = `${connector?.uid ?? ""}:${address ?? ""}:${chainId}:${target}`;
    if (asked.current === situation) return;
    asked.current = situation;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    void (async () => {
      const moved = await Promise.race([
        switchChain(config, { chainId: target }).then(
          () => true,
          () => false
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), SWITCH_TIMEOUT_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (cancelled || moved) return;

      // The switch did not happen. Two very different reasons look identical
      // from here, and they have different answers:
      //
      //  - the reader declined it, or the wallet cannot switch right now. The
      //    session still covers a chain Folio supports, so asking again works,
      //    and the "Wrong network" button already on screen is that ask.
      //  - the session covers no chain Folio supports. Nothing the page can
      //    request will change that — the approved namespaces are settled at
      //    pairing time — so the button has to offer a new pairing instead.
      const approved = await walletConnectChainIds(connector);
      if (cancelled) return;

      // An empty answer is "not a WalletConnect session" (an extension, the
      // Coinbase SDK), not "no chains approved". Those wallets can add a chain
      // on demand, so the chain modal is still the right escape.
      const unreachable = approved.length > 0 && !approved.some(isSupportedChainId);
      setChainReach(unreachable ? "unreachable" : "ok");
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [config, status, chainId, address, connector, target]);

  return null;
}
