"use client";

import { useEffect, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
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
 * ...and one whose last read failed outright.
 *
 * Slower than the empty case, in the other direction from everything else here.
 * The endpoint this is asking is rate limited by default (see lib/chains.ts),
 * and the most likely reason a read failed is that it asked too often — so
 * keeping the empty-wallet pace against a failing RPC re-buys the failure every
 * six seconds. The re-check button is the fast path when someone is actually
 * watching.
 */
const FAILING_MS = 20_000;

/**
 * ...and the other chains, once the target one has come back empty.
 *
 * Slower than either, because this answers a question that only changes when
 * the reader funds a wallet somewhere else: it is a diagnosis, not a gate.
 */
const ELSEWHERE_MS = 30_000;

/**
 * How long a read may go unanswered before the page stops calling it "checking"
 * and calls it unknown.
 *
 * Not a timeout — nothing is cancelled when this expires, and a late answer is
 * still taken. It bounds the *claim on screen*, which is the thing that was
 * wrong: "checking balance..." asserts a request is on its way back, and after
 * fifteen seconds that has stopped being a description of anything. What
 * replaces it says the balance is unknown and offers the button that re-asks,
 * which is true whatever went wrong underneath.
 *
 * Fifteen seconds because a healthy `eth_getBalance` on this L2 answers in well
 * under one, and the retry ladder below is sized to have given up by then in
 * the ordinary failure cases.
 */
const PATIENCE_MS = 15_000;

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
 *
 * The last state this had no name for was the one where nothing comes back at
 * all. Everything above assumes a read eventually lands or fails, and both
 * libraries under it default to waiting far longer than a person will: viem
 * retries a request three times at ten seconds each, and react-query retries
 * *that* three more times, so a rate-limited endpoint can hold the first read
 * open for minutes while the launch form says "checking balance..." — and the
 * paused case never lands at all, because react-query's default `networkMode`
 * stops a query outright when the browser claims to be offline, which is a
 * state with no data, no error, and no request running, rendered on screen as
 * a spinner that is waiting for nothing. `stalled` below is what ends both.
 */
export function useGasBalance({ address, chainId }: Options) {
  const config = useConfig();
  const queryClient = useQueryClient();
  const enabled = Boolean(address && chainId);

  /**
   * Bumped by `refetch`, to start the patience clock over.
   *
   * Pressing re-check has to make the page say "checking..." again even when
   * the state it is escaping was reached by running out of patience — otherwise
   * the button does something invisible and reads as broken.
   */
  const [attempt, setAttempt] = useState(0);

  const query = useBalance({
    address,
    chainId,
    query: {
      enabled,
      refetchInterval: (q) => {
        if (q.state.status === "error") return FAILING_MS;
        return q.state.data && q.state.data.value > 0n ? FUNDED_MS : EMPTY_MS;
      },
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,

      // One retry, not react-query's three. Underneath this, viem's http
      // transport is already retrying each request on exactly the responses
      // worth retrying — 429 and the 5xx family — so the default stacks two
      // ladders and turns one unreachable RPC into sixteen requests and the
      // better part of three minutes. A balance is re-read on a timer anyway:
      // the next attempt is seconds away regardless, and it is worth more when
      // the screen has admitted the last one failed.
      retry: 1,
      retryDelay: 1_000,

      // A paused query is indistinguishable from a pending one — no data, no
      // error, nothing in flight — and the default `online` mode pauses on the
      // browser's own offline event, which in-app wallet browsers fire
      // spuriously on any network handover and do not always take back. That is
      // the "stuck forever" report, and it survives a reload only because a
      // reload happens to land after the event.
      //
      // Folio has nothing to gain from the guess anyway: every read here is an
      // HTTP request to an RPC, so a network that is genuinely down comes back
      // as a transport error, which `unreadable` already says out loud and
      // honestly. Ask, and report what happens.
      networkMode: "always",
    },
  });

  const noGas = query.data !== undefined && query.data.value === 0n;

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
      // For the reason given on the balance query above. It fails quieter
      // here — a paused sweep reports no error and shows no spinner, it simply
      // never runs — which is worse, not better: the reader whose ETH is on
      // another chain is told nothing at all, on the one screen built to tell
      // them.
      networkMode: "always" as const,
    })),
  });

  /** A request is on its way back, right now. */
  const busy = query.isFetching || sweep.some((q) => q.isFetching);

  /** Nothing outstanding: the balance read has landed or failed, and the sweep
   *  beside it is idle. */
  const settled = (query.data !== undefined || query.isError) && !busy;

  /**
   * The read has been unanswered for longer than anyone should be asked to
   * watch a spinner.
   *
   * Deliberately blind to *why*. Every stuck state this hook has produced —
   * paused, retrying, hung behind a load balancer that will not close the
   * connection — looks the same from here and wants the same thing said about
   * it, so this measures the only thing they have in common: no answer yet.
   */
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!enabled || settled) {
      setStalled(false);
      return;
    }
    setStalled(false);
    const timer = setTimeout(() => setStalled(true), PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, settled, attempt, address, chainId]);

  /**
   * A read that failed is not a wallet that is empty.
   *
   * wagmi reports both as an absent balance, and every caller used to render
   * that absence as "checking balance..." forever — a spinner for a request
   * that already came back and lost. Naming the failure is what lets the UI
   * say the RPC is down rather than implying the reader's money is.
   *
   * Running out of patience counts as failing. The request may yet return, and
   * it is still collected if it does — but until it does there is no balance
   * here, and "unknown, press to re-ask" is the honest version of that. It is
   * gated on `enabled` so a hook with nothing to read reports nothing rather
   * than reporting a failure it never attempted.
   */
  const unreadable = enabled && query.data === undefined && (query.isError || stalled);

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

  /**
   * Re-ask, from the top.
   *
   * The cancel is what makes this a re-ask rather than a no-op. `refetch`
   * abandons an in-flight fetch only when there is already data to fall back
   * on — `query.fetch` checks `state.data !== undefined` before honouring its
   * own `cancelRefetch` — and otherwise hands back the promise of the fetch
   * already running. Which is precisely backwards for the press this button
   * exists for: the reader is looking at a *first* read that never answered, so
   * there is no data, so the button would silently attach them to the same
   * hung request and change nothing on screen.
   *
   * Cancelling first puts the query back to idle, so the refetch below is a new
   * request against a new connection. The abandoned one may still return; no
   * observer is listening by then.
   */
  const refetch = async () => {
    setAttempt((n) => n + 1);
    await Promise.all([
      queryClient.cancelQueries({ queryKey: query.queryKey }),
      queryClient.cancelQueries({ queryKey: ["gas-elsewhere", address] }),
    ]);
    return Promise.all([query.refetch(), ...sweep.map((q) => q.refetch())]);
  };

  return {
    balance: query.data,
    noGas,
    unreadable,
    /** Where the money is, when it isn't here. Null until the sweep finds it. */
    elsewhere,
    /**
     * True while a read is in flight, so a manual re-check can say so — and
     * false once it has been in flight too long to keep claiming that, which is
     * also what re-enables the button that gets out of it.
     */
    checking: busy && !stalled,
    refetch,
  };
}
