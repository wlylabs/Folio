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
 */
export function hasStoredWalletConnectSession(): boolean {
  if (typeof window === "undefined") return false;

  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !/^wc@2:client:.*\/\/session$/.test(key)) continue;

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
