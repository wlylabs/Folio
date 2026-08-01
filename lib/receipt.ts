import type { Config } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

/**
 * Waiting for a receipt, with an end to the waiting.
 *
 * `waitForTransactionReceipt` has no timeout by default: it watches for blocks
 * until one carries the transaction, forever if that never happens. Forever is
 * a real outcome here. The wallet broadcasts through its own node while this
 * page polls a public RPC, and when those two disagree — the RPC is
 * rate limited, or lagging, or behind a load balancer that drops the tx from
 * its mempool view — the receipt never arrives at this end even though the
 * transaction landed. The panel that was showing "Confirming..." then shows it
 * for the rest of the session, with a disabled button and no way back.
 *
 * So the wait is bounded, and running out is reported as its own outcome rather
 * than as a failure: the transaction was sent, and an explorer link is a better
 * answer than either a spinner or a red error. The caller re-enables its panel
 * either way.
 */

/** How long to watch before handing the wait back to the reader. */
export const RECEIPT_TIMEOUT_MS = 60_000;

/** How long a wallet may sit on a signature request before we say something. */
export const SIGNING_SLOW_MS = 20_000;

export type ReceiptOutcome =
  /** Mined, and the contract did what was asked. */
  | { kind: "success" }
  /** Mined, and reverted. */
  | { kind: "reverted" }
  /** Sent, but not seen in a block before the timeout. Not a failure. */
  | { kind: "pending" };

export async function awaitReceipt(
  config: Config,
  { hash, chainId }: { hash: `0x${string}`; chainId: number }
): Promise<ReceiptOutcome> {
  try {
    const receipt = await waitForTransactionReceipt(config, {
      hash,
      chainId,
      timeout: RECEIPT_TIMEOUT_MS,
      // Blocks here are seconds apart, and the default interval is tied to
      // the transport's, which for a public RPC is deliberately slow.
      pollingInterval: 2_000,
      // A node that has not seen the transaction yet is ordinary in the first
      // blocks after a send — that is a reason to keep asking, not to give up
      // before the timeout above does.
      retryCount: 12,
    });
    return { kind: receipt.status === "success" ? "success" : "reverted" };
  } catch (err) {
    if (isWaitTimeout(err)) return { kind: "pending" };
    throw err;
  }
}

/**
 * Whether the wait ran out rather than the transaction failing.
 *
 * Matched on the error name inside the message, for the same reason
 * lib/txErrors.ts does: viem wraps these several layers deep, and the name is
 * the part that survives the wrapping.
 */
function isWaitTimeout(err: unknown): boolean {
  const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /WaitForTransactionReceiptTimeoutError|TransactionNotFoundError|TransactionReceiptNotFoundError|timed out while waiting/i.test(
    message
  );
}
