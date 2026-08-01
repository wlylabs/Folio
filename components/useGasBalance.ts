"use client";

import { useQueries } from "@tanstack/react-query";
import { useBalance, useConfig } from "wagmi";
import { getBalance } from "wagmi/actions";
import { SUPPORTED_CHAINS, type ChainSlug } from "@/lib/chains";

/** How often to re-read a wallet that already has gas. */
const FUNDED_MS = 30_000;

/**
 * ...and one the page believes is empty.
 *
 * Faster, because that is the reading that costs the most when it is wrong:
 * it disables every button and puts the no-gas notice up. Still slower than
 * the quote polling beside it, since a balance only moves when the reader
 * does something.
 */
const EMPTY_MS = 6_000;

/**
 * ...and the other chains, once the target one has come back empty.
 *
 * Slower than either, because this answers a question that only changes when
 * the reader funds a wallet somewhere else: it is a diagnosis, not a gate.
 */
const ELSEWHERE_MS = 30_000;

type Options = {
  address: `0x${string}` | undefined;
  chainId: number | undefined;
};

/** A funded chain that isn't the one being read. See `elsewhere` below. */
export type FundsElsewhere = {
  slug: ChainSlug;
  name: string;
  value: bigint;
  symbol: string;
  decimals: number;
};

/**
 * The connected wallet's native balance, kept current on its own.
 *
 * ETH arrives somewhere this page cannot see: another tab, or a phone, while
 * this tab sits in front of the reader untouched. Nothing in wagmi tells us it
 * landed, and the only refetch the trade bar used to run was after a
 * transaction — which is exactly the transaction an empty wallet cannot send.
 * So the transfer confirmed on the explorer while Folio went on showing 0 ETH
 * and refusing to trade, with no way out but a reload.
 *
 * Polling closes that. `refetchOnWindowFocus` covers the common shape of it —
 * fund from the next tab, come back — and the interval covers the rest, where
 * the reader never leaves this tab at all. Neither runs while the tab is
 * hidden: `refetchIntervalInBackground` stays off, and focus is what wakes it.
 *
 * `noGas` is deliberately false while the first read is still in flight. An
 * unknown balance is not an empty one, and treating it as empty would flash
 * the no-gas notice at everybody on load.
 *
 * Polling only ever cures a stale read, though, and the report that prompted
 * the rest of this hook was not stale: the explorer showed the money landing,
 * the wallet showed the ETH, and Folio went on saying zero however often it
 * asked. It was asking a different question. `chainId` here is the *token's*
 * chain, not whichever one the wallet happens to be on, and every supported
 * chain spends something called ETH — so funding the wrong one looks identical
 * to a transfer that never arrived. `elsewhere` and `unreadable` exist to tell
 * those apart, because a bare zero cannot.
 */
export function useGasBalance({ address, chainId }: Options) {
  const config = useConfig();

  const query = useBalance({
    address,
    chainId,
    query: {
      enabled: Boolean(address && chainId),
      refetchInterval: (q) => (q.state.data && q.state.data.value > 0n ? FUNDED_MS : EMPTY_MS),
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    },
  });

  const noGas = query.data !== undefined && query.data.value === 0n;

  /**
   * A read that failed is not a wallet that is empty.
   *
   * wagmi reports both as an absent balance, and every caller used to render
   * that absence as "checking balance..." forever — a spinner for a request
   * that already came back and lost. Naming the failure is what lets the UI
   * say the RPC is down rather than implying the reader's money is.
   */
  const unreadable = query.data === undefined && query.isError;

  /**
   * The same address on every other supported chain, read only once this one
   * has come back empty.
   *
   * Extra round trips, on the one screen where they buy something no amount of
   * re-reading the target chain can: which chain the money actually went to.
   * Gated on `noGas` so a funded wallet never pays for them.
   *
   * Robinhood Chain is currently the only supported network, so `others` is
   * empty, no query is issued and `elsewhere` is always null — the diagnosis
   * costs nothing while there is nowhere else to look. It is written against
   * SUPPORTED_CHAINS rather than a hardcoded pair so that it starts answering
   * again the moment a second network is added, which is also why the callers
   * still render the `elsewhere` branch.
   */
  const others = SUPPORTED_CHAINS.filter((entry) => entry.chain.id !== chainId);
  const sweep = useQueries({
    queries: others.map((entry) => ({
      queryKey: ["gas-elsewhere", address, entry.chain.id],
      queryFn: () => getBalance(config, { address: address as `0x${string}`, chainId: entry.chain.id }),
      enabled: Boolean(address) && noGas,
      refetchInterval: ELSEWHERE_MS,
      refetchIntervalInBackground: false,
      // One chain being unreachable should not stop the others from answering,
      // and a retry storm across every network is the last thing a page in
      // this state needs.
      retry: false,
    })),
  });

  const funded = others
    .map((entry, i) => ({ entry, data: sweep[i]?.data }))
    .find(({ data }) => data !== undefined && data.value > 0n);

  const elsewhere: FundsElsewhere | null =
    funded && funded.data
      ? {
          slug: funded.entry.slug,
          name: funded.entry.chain.name,
          value: funded.data.value,
          symbol: funded.data.symbol,
          decimals: funded.data.decimals,
        }
      : null;

  return {
    balance: query.data,
    noGas,
    unreadable,
    /** Where the money is, when it isn't here. Null until the sweep finds it. */
    elsewhere,
    /** True while a read is in flight, so a manual re-check can say so. */
    checking: query.isFetching || sweep.some((q) => q.isFetching),
    refetch: () => Promise.all([query.refetch(), ...sweep.map((q) => q.refetch())]),
  };
}
