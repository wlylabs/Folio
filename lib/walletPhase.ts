"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { hasStoredWalletConnectSession } from "./walletSession";

/**
 * How long a reader watches "Connecting…" before the page admits it has no
 * news.
 *
 * Counted in foreground time only — see below. Long enough to cover the whole
 * of WalletSessionSync's adoption schedule, which runs to eight seconds after
 * the return, plus room for a relay that is catching up behind it.
 */
const STALL_AFTER_MS = 20_000;

export type ConnectPhase =
  /** Nothing in flight: the button is an offer. */
  | "idle"
  /** A connection is being picked up, with nothing on screen to show for it. */
  | "waiting"
  /** Still nothing, long enough that silence is now the more likely story. */
  | "stalled";

/**
 * What a connect control is in the middle of, if anything.
 *
 * The case this exists for is the walk back from a phone wallet. The approval
 * happened in another app, so wagmi has no connection of its own to replay —
 * only a WalletConnect session sitting in storage, which WalletSessionSync is
 * in the middle of adopting. Between the two, the account is empty and the
 * honest label is not "Connect wallet": the reader just connected, and being
 * asked to do it again reads as a site that lost their approval.
 *
 * Two conditions decide that, and both matter:
 *
 *  - "connecting" is always the reader's own press, so it always counts.
 *  - "reconnecting" is the status every page load starts in, including for
 *    somebody who has never owned a wallet. Showing them a spinning Connecting…
 *    on arrival would be a lie in the other direction, so it only counts when
 *    there is a stored session behind it.
 *
 * The storage read is deferred to an effect: it cannot run during SSR, and a
 * first client render that disagreed with the server's markup would be a
 * hydration mismatch. It re-runs on each status change, which is when a session
 * appears.
 *
 * "stalled" is the third state, and it is the one the button used to be
 * missing. Nothing times a connect out: a pairing the wallet never answers, an
 * approval that went to a relay and stopped there, an app that never handed the
 * reader back — all of them leave wagmi reporting "connecting" indefinitely,
 * and the button swept a progress bar under the word Connecting… for as long as
 * the reader was willing to watch it. That is the same lie as the first one,
 * told slowly. So after a while the button goes back to being an offer they can
 * press, and a line underneath says what is and isn't known.
 *
 * The clock runs on foreground time and restarts every time the page comes
 * back, because the minutes spent inside the wallet app are not the reader
 * waiting on Folio — they are the reader doing the thing Folio asked for. It is
 * the wait *here*, uninterrupted, that means nothing is coming.
 *
 * It lives in lib rather than beside the button because there is more than one
 * connect control now — the settings panel's, and the one ConnectCue puts where
 * a reader was stopped. Two copies of this would drift, and the second copy
 * would be the one that never got the stall.
 */
export function useConnectPhase(): ConnectPhase {
  const { status } = useAccount();
  const [stored, setStored] = useState(false);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    setStored(hasStoredWalletConnectSession());
  }, [status]);

  const pending = status === "connecting" || (status === "reconnecting" && stored);

  useEffect(() => {
    if (!pending) {
      setStalled(false);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const start = () => {
      if (timer) clearTimeout(timer);
      setStalled(false);
      timer = setTimeout(() => setStalled(true), STALL_AFTER_MS);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else if (timer) clearTimeout(timer);
    };

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [pending]);

  if (!pending) return "idle";
  return stalled ? "stalled" : "waiting";
}
