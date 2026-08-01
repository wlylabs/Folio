"use client";

import { useSyncExternalStore } from "react";

/**
 * Can the connected wallet still be moved to a chain Folio supports?
 *
 * "Wrong network" assumes it can — press the button, pick the network, done.
 * That assumption holds for an extension, where the chain list is the wallet's
 * own and `wallet_addEthereumChain` can add anything missing from it. It does
 * not hold for WalletConnect, where the set of chains a session may speak for
 * is fixed at the moment the wallet approves the pairing. A wallet that
 * approved Folio on Ethereum Mainnet alone has given the page a session that
 * *cannot* carry Base Sepolia, however many times it is asked: the switch
 * request is refused, or accepted and then never reported back, and the reader
 * is returned to the same wrong network with nothing to show for the trip.
 *
 * The only thing that changes that is a new pairing. So ChainSync publishes
 * what it found out by trying, and the connect button reads it — "Wrong
 * network", which opens a chain modal that cannot help, becomes "Reconnect
 * wallet", which tears the session down and asks again.
 *
 * A module-level store rather than context, for the same reason as
 * lib/preferredChain.ts: the writer (ChainSync) and the readers (a connect
 * button, anywhere) are siblings, and context only travels downward.
 */

export type ChainReach =
  /** Nothing known against the wallet: no session, a supported chain already,
   *  or a switch that was merely declined and can be asked for again. */
  | "ok"
  /** A live WalletConnect session whose approved chains include none of ours. */
  | "unreachable";

let reach: ChainReach = "ok";
const listeners = new Set<() => void>();

/** Called by ChainSync, and by nothing else. */
export function setChainReach(next: ChainReach): void {
  if (next === reach) return;
  reach = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ChainReach {
  return reach;
}

/** The server renders no wallet, so it renders the state that hides the notice.
 *  Keeping this separate from getSnapshot is what stops one request's finding
 *  from leaking into someone else's markup. */
function getServerSnapshot(): ChainReach {
  return "ok";
}

export function useChainReach(): ChainReach {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
