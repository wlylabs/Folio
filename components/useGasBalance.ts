"use client";

import { useBalance } from "wagmi";

/** How often to re-read a wallet that already has gas. */
const FUNDED_MS = 30_000;

/**
 * ...and one the page believes is empty.
 *
 * Faster, because that is the reading that costs the most when it is wrong:
 * it disables every button and puts the faucet notice up. Still slower than
 * the quote polling beside it, since a balance only moves when the reader
 * does something.
 */
const EMPTY_MS = 6_000;

type Options = {
  address: `0x${string}` | undefined;
  chainId: number | undefined;
};

/**
 * The connected wallet's native balance, kept current on its own.
 *
 * A faucet claim happens somewhere this page cannot see: another tab, or a
 * phone, while this tab sits in front of the reader untouched. Nothing in
 * wagmi tells us the ETH landed, and the only refetch the trade bar used to
 * run was after a transaction — which is exactly the transaction an empty
 * wallet cannot send. So the claim confirmed on the explorer while Folio went
 * on showing 0 ETH and refusing to trade, with no way out but a reload.
 *
 * Polling closes that. `refetchOnWindowFocus` covers the common shape of it —
 * claim in the next tab, come back — and the interval covers the rest, where
 * the reader never leaves this tab at all. Neither runs while the tab is
 * hidden: `refetchIntervalInBackground` stays off, and focus is what wakes it.
 *
 * `noGas` is deliberately false while the first read is still in flight. An
 * unknown balance is not an empty one, and treating it as empty would flash
 * the faucet notice at everybody on load.
 */
export function useGasBalance({ address, chainId }: Options) {
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

  return {
    balance: query.data,
    noGas: query.data !== undefined && query.data.value === 0n,
    /** True while a read is in flight, so a manual re-check can say so. */
    checking: query.isFetching,
    refetch: query.refetch,
  };
}
