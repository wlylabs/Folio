import type { Config } from "wagmi";
import { getAccount, getConnectorClient, reconnect, watchAccount } from "wagmi/actions";

/**
 * The wallet looks connected but nothing behind it can sign yet.
 *
 * Its message is written for a person: this is what the trade bar shows when a
 * restored session can't be revived, in place of wagmi's "Connector not
 * connected."
 */
export class WalletNotReadyError extends Error {
  constructor(
    message = "Your wallet session dropped. Reconnect your wallet, then try again."
  ) {
    super(message);
    this.name = "WalletNotReadyError";
  }
}

/** How long to wait for an in-flight reconnect before giving up on it. */
const SETTLE_TIMEOUT_MS = 8_000;

/**
 * Prove the wallet can actually sign before asking it to.
 *
 * wagmi persists the connected account to storage, so on a fresh load — a new
 * tab, or a phone browser restoring a backgrounded page — it replays the last
 * address into `useAccount` while it re-attaches the real connector in the
 * background. During that window `status` is "reconnecting" and, per wagmi's
 * own `getAccount`, `isConnected` is already true: the header shows the
 * address, the buy button is live, and the connector behind it is a
 * placeholder restored from JSON with no provider attached. Signing then fails
 * with "Connector not connected." — the wallet is fine, the page just asked it
 * to sign before it woke up.
 *
 * So: fetch the connector's client, which is what `writeContract` does anyway.
 * If it isn't there, wait out any reconnect already running, then run one
 * ourselves — that revives the session in the common case — and only give up
 * if the wallet still has nothing to offer.
 */
export async function ensureWalletReady(config: Config): Promise<void> {
  if (await canSign(config)) return;

  await settled(config);
  if (await canSign(config)) return;

  // Its own in-flight guard makes a concurrent call a no-op, which is why the
  // wait above comes first.
  await reconnect(config).catch(() => undefined);
  if (await canSign(config)) return;

  throw new WalletNotReadyError();
}

/**
 * Whether the connector can hand back a signing client right now.
 *
 * Deliberately catches everything: a missing connection throws
 * ConnectorNotConnectedError, while a half-hydrated one throws a TypeError
 * from calling a method the stored placeholder doesn't have. Both mean the
 * same thing here — not ready — and both are answered by a reconnect.
 *
 * `assertChainId` stays off because a wallet sitting on the wrong network is a
 * different problem, fixed by switchChain a moment later.
 */
async function canSign(config: Config): Promise<boolean> {
  try {
    await getConnectorClient(config, { assertChainId: false });
    return true;
  } catch {
    return false;
  }
}

/** Resolve once wagmi is neither connecting nor reconnecting, or on timeout. */
function settled(config: Config): Promise<void> {
  if (!isPending(getAccount(config).status)) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unwatch();
      resolve();
    };
    const timer = setTimeout(done, SETTLE_TIMEOUT_MS);
    const unwatch = watchAccount(config, {
      onChange(account) {
        if (!isPending(account.status)) done();
      },
    });
  });
}

function isPending(status: string): boolean {
  return status === "reconnecting" || status === "connecting";
}
