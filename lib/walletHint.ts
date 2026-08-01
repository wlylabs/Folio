/**
 * Whether the masthead should expect a wallet back.
 *
 * The problem this solves is small and very visible. wagmi is configured for
 * SSR, so the server renders every page as though no wallet were connected —
 * it cannot know otherwise — and the reader's session is revived a few hundred
 * milliseconds into the client's life. For a reader who has connected one, that
 * means the masthead gains a link, and the settings button and everything
 * beside it slide sideways, on every single reload. It is the jump that reads
 * as the page glitching.
 *
 * So the answer is remembered here, written whenever wagmi settles and read
 * synchronously by the boot script before the first paint (see lib/boot.ts).
 * The attribute it puts on <html> lets the stylesheet hold the space for that
 * link while wagmi catches up, so the bar is laid out once instead of twice.
 *
 * What this is not is a claim about the wallet. It says "a wallet was connected
 * the last time this browser left the site", which is a good guess and nothing
 * more — the reader may have disconnected in the wallet app, cleared storage, or
 * come back a month later. Nothing reads it to decide what to show; wagmi
 * decides that, as it always did. This only decides how much room to leave.
 */

/** localStorage key. `"1"` means a wallet was connected when we last looked. */
export const WALLET_HINT_KEY = "folio_wallet_hint";

/** Put on <html> by the boot script when the key above says so. */
export const WALLET_HINT_ATTRIBUTE = "data-wallet";

/**
 * Record the answer, and apply it to the document.
 *
 * Called from the masthead every time wagmi's status settles — which is also
 * what clears the hint for a reader who disconnects, so the space stops being
 * held on the next reload rather than being held forever.
 */
export function rememberWalletHint(connected: boolean): void {
  try {
    if (connected) window.localStorage.setItem(WALLET_HINT_KEY, "1");
    else window.localStorage.removeItem(WALLET_HINT_KEY);
  } catch {
    // Storage unavailable. The page works; the next reload just lays the
    // masthead out twice, which is where this started.
  }

  const root = document.documentElement;
  if (connected) root.setAttribute(WALLET_HINT_ATTRIBUTE, "");
  else root.removeAttribute(WALLET_HINT_ATTRIBUTE);
}
