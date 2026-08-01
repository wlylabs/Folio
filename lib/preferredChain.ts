"use client";

import { useEffect, useId, useSyncExternalStore } from "react";
import { DEFAULT_CHAIN_SLUG, isChainSlug, type ChainSlug } from "@/lib/chains";
import { FACTORY_DEPLOYMENT } from "@/lib/contracts/deployment";

/**
 * Which chain the page in front of the reader is about.
 *
 * A wallet that connects on Ethereum mainnet — the network almost every wallet
 * opens on — is on a chain Folio does not support, and the only honest thing
 * the connect button can say about that is "Wrong network". Asking the wallet
 * to move is better, but "move where?" has no single answer: a token page is
 * about the chain that token was launched on, the create form is about the
 * chain the launch is being signed to, and everything else is about wherever
 * the factory lives.
 *
 * So pages declare their chain and ChainSync reads it. A declaration is a
 * claim held for as long as the component is mounted; the newest claim wins,
 * and when it unmounts the previous one takes over again. Nothing declared
 * falls back to APP_CHAIN_SLUG.
 *
 * A module-level store rather than React context, because the reader
 * (Providers, above the whole tree) sits above the writers (a trade bar, a
 * form) and context only travels the other way.
 */

/** Where Folio is, absent a page saying otherwise: the default chain's factory,
 *  or the first chain that has one. Same rule as the footer and settings panel. */
export const APP_CHAIN_SLUG: ChainSlug = FACTORY_DEPLOYMENT?.chain ?? DEFAULT_CHAIN_SLUG;

type Claim = { key: string; slug: ChainSlug };

let claims: Claim[] = [];
let snapshot: ChainSlug = APP_CHAIN_SLUG;
const listeners = new Set<() => void>();

function publish() {
  const next = claims.length > 0 ? claims[claims.length - 1].slug : APP_CHAIN_SLUG;
  // useSyncExternalStore compares snapshots by identity, and slugs are strings,
  // so an unchanged value must not notify — it would re-render every reader on
  // any mount or unmount.
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ChainSlug {
  return snapshot;
}

/** The server renders no wallet, so it renders the fallback. Keeping this
 *  separate from getSnapshot is what stops a claim made by an earlier request
 *  in the same process from leaking into someone else's markup. */
function getServerSnapshot(): ChainSlug {
  return APP_CHAIN_SLUG;
}

/** The chain a connected wallet should be on right now. */
export function usePreferredChainSlug(): ChainSlug {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Declare what this part of the page is about, for as long as it is mounted.
 *
 * Takes a plain string because the usual argument is a `tokens.chain` value
 * out of the database, which can name a chain this build no longer supports —
 * that is ignored rather than claimed, leaving whatever was already in force.
 */
export function useDeclarePreferredChain(slug: string | null | undefined): void {
  const key = useId();

  useEffect(() => {
    if (!isChainSlug(slug)) return;

    claims = [...claims.filter((claim) => claim.key !== key), { key, slug }];
    publish();

    return () => {
      claims = claims.filter((claim) => claim.key !== key);
      publish();
    };
  }, [key, slug]);
}
