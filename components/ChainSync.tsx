"use client";

import { useEffect, useRef } from "react";
import { useAccount, useConfig } from "wagmi";
import { switchChain } from "wagmi/actions";
import { chainBySlug, isSupportedChainId } from "@/lib/chains";
import { usePreferredChainSlug } from "@/lib/preferredChain";

/**
 * Move a wallet that landed on a chain Folio cannot use.
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
 * Only unsupported chains. A wallet on Sepolia while the page is about a Base
 * Sepolia token is a *different* problem, and one the trade bar already solves
 * at the right moment: it switches when there is a transaction to sign, so
 * reading a page never moves a wallet the reader deliberately put somewhere.
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
export default function ChainSync() {
  const config = useConfig();
  const { address, chainId, connector, status } = useAccount();
  const target = chainBySlug(usePreferredChainSlug())?.chain.id;

  // The last situation a switch was requested for, so a decline is not asked
  // about again. A ref, not state: it must not itself cause a render.
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "connected" || target === undefined) return;
    // Already somewhere Folio can work.
    if (isSupportedChainId(chainId)) return;

    const situation = `${connector?.uid ?? ""}:${address ?? ""}:${chainId}:${target}`;
    if (asked.current === situation) return;
    asked.current = situation;

    void switchChain(config, { chainId: target }).catch(() => {
      // Declined, or a wallet that cannot switch — WalletConnect sessions with
      // a single approved chain are the common case. The "Wrong network"
      // button is already on screen and opens the chain modal.
    });
  }, [config, status, chainId, address, connector, target]);

  return null;
}
