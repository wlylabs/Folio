/**
 * When the expensive half of the wallet layer is allowed to exist.
 *
 * ---------------------------------------------------------------------------
 * The problem this exists for
 * ---------------------------------------------------------------------------
 *
 * A wagmi connector is cheap to *describe* and expensive to *build*. Describing
 * one is the wallet list in lib/wagmiConfig.ts; building one means fetching and
 * parsing the wallet's SDK and then handshaking with its relay. Measured on the
 * front page of a production build, that is:
 *
 *   ~416 KB  @walletconnect/ethereum-provider, and the universal provider and
 *            core underneath it — the QR pairing every phone wallet uses
 *   ~502 KB  @reown/appkit, WalletConnect's own modal, which RainbowKit
 *            registers a second connector for
 *   ~240 KB  Coinbase's wallet SDK
 *
 * — about 1.2 MB of JavaScript, plus a relay websocket and two calls out to
 * WalletConnect's servers, one of them a telemetry ping to
 * pulse.walletconnect.org.
 *
 * None of it was waiting to be asked for. wagmi calls `connector.setup()` on
 * every connector while `createConfig` is still running, and its mount-time
 * `reconnect()` walks the whole list calling `getProvider()` on each — so a
 * reader who came to read an article downloaded every wallet SDK Folio offers
 * before the page had finished hydrating, on every page, whether or not they
 * have ever owned a wallet. And then pressed "Connect wallet" on a main thread
 * still working through it. That is the slow connect this module answers: the
 * press was queued behind a megabyte of work the press had not asked for.
 *
 * ---------------------------------------------------------------------------
 * What happens instead
 * ---------------------------------------------------------------------------
 *
 * Two levels, each released by the reader getting one step closer to
 * connecting, and each early enough that the work is done before the step
 * after it:
 *
 *   PANEL  the reader hovers, focuses or presses the Settings button — the
 *          door to the wallet the site shows. Releases the connectors the
 *          connect modal actually lists. See components/SettingsMenu.tsx.
 *
 *   MODAL  the connect modal is about to open, or a pointer has arrived at a
 *          button that opens it. Releases RainbowKit's second WalletConnect
 *          connector, the one that opens WalletConnect's own modal instead of
 *          RainbowKit's QR view — half a megabyte that only matters to a
 *          reader who picks that entry by name. See components/ConnectCue.tsx.
 *
 * The second level is the one that matters for a reader who never touches the
 * masthead, and there are plenty: somebody who lands on a token article from a
 * link and reaches straight for the trade panel passes no Settings button on
 * the way. The connect button they do reach for is the signal, and reaching is
 * a beat earlier than pressing — which is the beat the press used to be paying
 * for.
 *
 * A reader who goes near neither downloads none of it.
 *
 * Neither level is a promise anything is *ready* — they release work, they do
 * not wait for it. Nothing here is on the path of a connect that is already
 * happening: lib/wagmiConfig.ts opens both levels itself the moment a
 * connector is actually asked to connect, so a connect can never be blocked on
 * a level that was somehow never released.
 *
 * A module-level registry rather than context, for the same reason as
 * lib/walletChainReach.ts: the writers are a button in the masthead and the
 * readers are connectors built before React exists.
 */

/** Released by intent toward the settings panel. */
export const WALLET_BOOT_PANEL = 1;

/** Released when the connect modal opens. */
export const WALLET_BOOT_MODAL = 2;

export type WalletBootLevel = typeof WALLET_BOOT_PANEL | typeof WALLET_BOOT_MODAL;

type Waiting = { level: WalletBootLevel; task: () => void };

let reached = 0;
let waiting: Waiting[] = [];

/** How far the wallet layer has been allowed to build itself. */
export function walletBootLevel(): number {
  return reached;
}

/**
 * Run `task` once the wallet layer reaches `level`, or now if it already has.
 *
 * Used by lib/wagmiConfig.ts to hold each connector's `setup()` — the call
 * wagmi makes from inside `createConfig`, before anything is on screen, on
 * every page of the site. Deferring it is safe because `setup` only subscribes
 * to a provider's events: nothing reads its result, `connect()` fetches its own
 * provider, and wagmi never checks whether it ran.
 */
export function onWalletBoot(level: WalletBootLevel, task: () => void): void {
  if (reached >= level) {
    task();
    return;
  }
  waiting.push({ level, task });
}

/**
 * Let the wallet layer build itself up to `level`.
 *
 * Idempotent, and cheap enough to call from an event that fires on every
 * pointer move over a button: reaching a level already reached does nothing.
 * Each task is isolated — a connector whose SDK fails to load must not take
 * the others with it, and every one of these is a `setup()` whose failure
 * wagmi already tolerates.
 */
export function bootWallets(level: WalletBootLevel = WALLET_BOOT_PANEL): void {
  if (reached >= level) return;
  reached = level;

  const due = waiting.filter((entry) => entry.level <= reached);
  waiting = waiting.filter((entry) => entry.level > reached);

  for (const { task } of due) {
    try {
      task();
    } catch {
      // A connector that cannot subscribe to its own provider is a connector
      // that will fail again, visibly, when it is asked to connect. There is
      // nothing to report here that the connect button will not report better.
    }
  }
}
