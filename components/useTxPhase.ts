"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SIGNING_SLOW_MS } from "@/lib/receipt";

export type TxPhase = "idle" | "signing" | "confirming";

/** How long a receipt wait may run before the escape hatch is offered. */
const CONFIRMING_SLOW_MS = 25_000;

/**
 * Where a transaction has got to, and a way out when it gets nowhere.
 *
 * The trade panels used to track this as one boolean, `pending`, set before the
 * wallet call and cleared in a `finally`. That is fine while every promise
 * settles, and both of them can fail not to. `writeContract` waits on the
 * wallet with no timeout of its own: a phone wallet reached over WalletConnect
 * can swallow the request — the app never opens, or it opens, approves, and the
 * response never makes it back over the relay — and the promise simply never
 * resolves. The `finally` never runs, the button reads "Confirming..." forever,
 * and there is nothing on the page to press. That is the stuck confirmation.
 *
 * Two things fix it. The phase says which wait is running, so "your wallet has
 * not answered" stops being reported with the same word as "the chain has not
 * mined it" — different problems, different next steps. And `slow` turns on
 * once a wait has gone on long enough to be worth doubting, which is what puts
 * `abandon` on screen: it retires the run so a late resolution can no longer
 * touch the panel, and hands the controls back. Nothing on chain is undone by
 * it — a signed transaction stays signed — but the reader can try again, or go
 * look at the explorer, instead of reloading the page.
 */
export function useTxPhase() {
  const [phase, setPhase] = useState<TxPhase>("idle");
  const [slow, setSlow] = useState(false);

  // Every run takes a number. `alive` compares against the current one, so a
  // promise that resolves after being abandoned — or after a second attempt
  // started — writes nothing.
  const runId = useRef(0);

  useEffect(() => {
    setSlow(false);
    if (phase === "idle") return;

    const after = phase === "signing" ? SIGNING_SLOW_MS : CONFIRMING_SLOW_MS;
    const timer = setTimeout(() => setSlow(true), after);
    return () => clearTimeout(timer);
  }, [phase]);

  /** Begin a run. The returned check is false once this run is superseded. */
  const begin = useCallback(() => {
    const id = ++runId.current;
    setPhase("signing");
    return () => runId.current === id;
  }, []);

  /** Move a live run on to waiting for the chain. */
  const confirming = useCallback(() => setPhase("confirming"), []);

  /** Finish a live run. */
  const done = useCallback(() => setPhase("idle"), []);

  /** Stop waiting: retire the run, release the panel. */
  const abandon = useCallback(() => {
    runId.current += 1;
    setPhase("idle");
    setSlow(false);
  }, []);

  return {
    phase,
    pending: phase !== "idle",
    /** True once this wait has run long enough to offer a way out of it. */
    slow,
    begin,
    confirming,
    done,
    abandon,
  };
}
