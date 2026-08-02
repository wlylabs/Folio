/**
 * The wallet this browser picked last time, and why none of it outlives a
 * disconnect.
 *
 * ---------------------------------------------------------------------------
 * The problem this exists for
 * ---------------------------------------------------------------------------
 *
 * Disconnecting does not put the connect modal back the way the reader first
 * met it. Three separate libraries each keep their own note of which wallet was
 * chosen, none of them clears it on disconnect, and every one of those notes
 * changes what the reader is offered the next time they press Connect:
 *
 *  - RainbowKit hoists the remembered wallet to the top of the modal and prints
 *    "Recent" beside it. So a reader who connected once over WalletConnect is
 *    met by WalletConnect first, forever, even after they deliberately left.
 *
 *  - WalletConnect's deep link choice sends the *next* pairing straight back to
 *    the same wallet app on a phone, with no list in between — which is the
 *    version of this that cannot be recovered from by scrolling past it.
 *
 *  - wagmi's `recentConnectorId` is read at mount, and Folio reads it too:
 *    lib/wagmiConfig.ts builds a connector's SDK eagerly when it matches, so a
 *    stale one has a reader who no longer has a wallet paying for a wallet SDK
 *    on every page load.
 *
 * The assumption underneath all three is that a reader has one wallet and will
 * come back to it. Plenty have two — an extension on the desktop and a phone
 * wallet, a personal account and one they trade from — and disconnecting is
 * exactly the move somebody makes when they intend to arrive as somebody else.
 * Offering them the wallet they just left, first and by name, is answering the
 * one question they were trying to ask.
 *
 * So: on disconnect, every note goes, and the next press of Connect draws the
 * same default list a reader who has never connected sees.
 *
 * ---------------------------------------------------------------------------
 * What this is not
 * ---------------------------------------------------------------------------
 *
 * Not a session teardown. The session itself is wagmi's to end, and it has
 * already ended by the time anything here runs — these are only the breadcrumbs
 * left behind it. Clearing them can therefore never disconnect anybody, and a
 * failure to clear them costs a misordered modal, nothing more. Which is why
 * every write here is best-effort: storage can be unavailable (Safari private
 * mode, a blocked third-party frame) and that is not worth an error path.
 */

/**
 * The keys, by the library that owns them.
 *
 * Written out rather than swept by prefix because a prefix sweep over
 * `@appkit/` would also take the caches and the network state Reown keeps
 * there, and this is a change of mind about wallets, not a factory reset.
 */
const WALLET_CHOICE_KEYS = [
  // RainbowKit. `rk-recent` is the JSON array behind the "Recent" badge and the
  // reordering; `rk-latest-id` is the single last connector, which RainbowKit
  // does clear on disconnect itself — it is named here so that the set is
  // complete and stays complete if that ever changes.
  "rk-recent",
  "rk-latest-id",

  // WalletConnect, and Reown's AppKit under it, which both write this one. It
  // is the phone deep link: with it set, pairing skips the wallet list and
  // opens the remembered app. RainbowKit clears it on disconnect too, but only
  // the copy its own modal wrote — the AppKit modal (RainbowKit's second
  // WalletConnect entry, see lib/wagmiConfig.ts) sets it on its own schedule.
  "WALLETCONNECT_DEEPLINK_CHOICE",

  // Reown AppKit's own memory of the picked wallet: the recents list its modal
  // shows, and the id/name pair it labels a restored connection with.
  "@appkit/recent_wallets",
  "@appkit/wallet_id",
  "@appkit/wallet_name",
  "@appkit/connection_status",
] as const;

/**
 * AppKit's connected-connector keys, which carry the CAIP namespace in the
 * middle — `@appkit/eip155:connected_connector_id` today, and one per namespace
 * for a reader who has connected on more than one. Matched by shape for the
 * same reason lib/walletSession.ts matches WalletConnect's session keys by
 * shape: the literal moves with the library, the shape does not.
 */
const APPKIT_CONNECTOR_KEY = /^@appkit\/[^:]+:connected_connector_id$/;

/**
 * Forget which wallet this browser last used.
 *
 * Called when a connected wallet goes away — whether the reader pressed
 * Disconnect in Folio, disconnected from inside the wallet app, or Folio tore
 * the session down itself to ask for a better one (see `useSessionRepair` in
 * components/WalletButton.tsx). All three mean the same thing to the connect
 * modal: start over.
 */
export function forgetWalletChoice(): void {
  if (typeof window === "undefined") return;

  try {
    const storage = window.localStorage;

    for (const key of WALLET_CHOICE_KEYS) storage.removeItem(key);

    // Collected before removing: `key(i)` walks a live list, and deleting from
    // under it skips entries.
    const namespaced: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && APPKIT_CONNECTOR_KEY.test(key)) namespaced.push(key);
    }
    for (const key of namespaced) storage.removeItem(key);
  } catch {
    // Storage unavailable. The reader gets the modal they got before this
    // existed, which is the failure this was written to improve on and not one
    // it can make worse.
  }
}
