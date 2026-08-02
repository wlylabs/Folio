/**
 * Is there a WalletConnect session sitting in storage that the page has not
 * picked up?
 *
 * @walletconnect/core persists its stores under
 * `wc@2:client:<version>:<prefix>//<name>`, so the sessions live at a key like
 * `wc@2:client:0.3:clientTwo//session` — the prefix is RainbowKit's, and the
 * version moves with the library, so match the shape rather than the literal.
 *
 * The point is to keep the reconnect in WalletSessionSync cheap: without this,
 * every return to the tab would walk every connector RainbowKit registered,
 * asking each one for a provider, on the overwhelmingly common case of a reader
 * who simply never connected a wallet.
 *
 * `prefix` narrows it to one client's sessions. RainbowKit runs two: the
 * connector behind its own QR view stores under `clientTwo`, and the one that
 * opens WalletConnect's own modal under `clientOne`. lib/wagmiConfig.ts asks
 * per connector, because "somebody has a session" is not a reason to spend half
 * a megabyte building the client that does not hold it. An unrecognised prefix
 * simply finds nothing, and the connector then waits for the reader to press
 * something — the safe way for this to be wrong.
 */
export function hasStoredWalletConnectSession(prefix?: string): boolean {
  if (typeof window === "undefined") return false;

  const wanted = prefix
    ? new RegExp(`^wc@2:client:[^:]+:${prefix}//session$`)
    : /^wc@2:client:.*\/\/session$/;

  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !wanted.test(key)) continue;

      const value = window.localStorage.getItem(key);
      if (!value) continue;

      const sessions = JSON.parse(value);
      if (Array.isArray(sessions) && sessions.length > 0) return true;
    }
  } catch {
    // Storage can be unavailable (Safari private mode, a blocked third-party
    // frame) or hold something that is not JSON. Either way: nothing to adopt.
    return false;
  }

  return false;
}

/** The part of a connector this module needs, so it takes wagmi's `Connector`
 *  without importing a type that drags the whole config in. */
type ProviderSource = { getProvider: () => Promise<unknown> };

/** The part of a WalletConnect provider this module needs. Anything else — an
 *  injected wallet, a Coinbase SDK provider — simply has no `session`. */
type MaybeSessionProvider = {
  session?: { namespaces?: Record<string, { accounts?: string[] } | undefined> };
};

/**
 * The chain ids a connector's WalletConnect session was actually approved for.
 *
 * The session's namespaces are the wallet's answer to the pairing proposal, and
 * they are the ceiling on everything afterwards: a request can only be sent for
 * a chain in there, and `wallet_switchEthereumChain` for one that isn't is
 * refused by the wallet or dropped on the floor. So this is how the page tells
 * "the reader's wallet is parked on the wrong network" (fixable with a switch)
 * apart from "this session can never speak for Robinhood Chain" (fixable only
 * by pairing again). See lib/walletChainReach.ts.
 *
 * Empty for a connector with no session at all, which is every connector that
 * is not WalletConnect — callers must read that as "no answer", not as "no
 * chains approved".
 */
export async function walletConnectChainIds(
  connector: ProviderSource | undefined | null
): Promise<number[]> {
  if (!connector) return [];

  let provider: unknown;
  try {
    provider = await connector.getProvider();
  } catch {
    // A connector that cannot produce a provider has no session to read.
    return [];
  }

  const namespaces = (provider as MaybeSessionProvider | undefined)?.session?.namespaces;
  if (!namespaces) return [];

  // Accounts are CAIP-10 — `eip155:4663:0x…` — and the namespace key is
  // sometimes the bare `eip155` and sometimes chain-scoped, so every entry is
  // read rather than one looked up by name.
  const ids = new Set<number>();
  for (const namespace of Object.values(namespaces)) {
    for (const account of namespace?.accounts ?? []) {
      const id = Number(account.split(":")[1]);
      if (Number.isInteger(id)) ids.add(id);
    }
  }
  return [...ids];
}
