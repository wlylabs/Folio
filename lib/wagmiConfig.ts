import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http, type Chain, type Transport } from "viem";
import { SUPPORTED_CHAINS } from "./chains";
import { walletConnectMetadata } from "./walletMetadata";

const PLACEHOLDER_PROJECT_ID = "00000000000000000000000000000000";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

/**
 * Whether a real WalletConnect project ID was configured.
 *
 * False means the placeholder below is in play: extension wallets still work,
 * but every phone wallet — which reaches the site over WalletConnect's relay —
 * cannot pair at all. That is worth saying out loud in the UI rather than only
 * in the console, because the failure looks like a broken site, not a missing
 * environment variable. See SettingsMenu.
 */
export const hasWalletConnectProjectId =
  Boolean(projectId) && projectId !== PLACEHOLDER_PROJECT_ID;

// RainbowKit throws from getDefaultConfig when projectId is missing, and this
// module is imported by the root layout — so an unset variable failed
// `next build` while prerendering, before any page could render. Fall back to a
// placeholder instead: injected wallets (MetaMask, Rabby, Coinbase extension)
// still connect, and only WalletConnect's QR pairing needs a real ID.
if (!hasWalletConnectProjectId && typeof window !== "undefined") {
  console.warn(
    "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set. WalletConnect pairing " +
      "is disabled, so phone wallets cannot connect; browser-extension wallets " +
      "still work. Get a free project ID at cloud.walletconnect.com (see " +
      ".env.example)."
  );
}

// Non-empty by construction; getDefaultConfig wants a non-empty tuple.
const chains = SUPPORTED_CHAINS.map((entry) => entry.chain) as unknown as readonly [
  Chain,
  ...Chain[],
];

/**
 * Read endpoints for the browser, from the same NEXT_PUBLIC_RPC_* variables the
 * server already uses (see publicClientFor).
 *
 * Without this the page falls back to each chain's built-in public endpoint for
 * every read it makes — balances included. Those are shared and aggressively
 * rate limited, so a throttled read leaves a balance unresolved rather than
 * wrong, which reads on screen as a wallet that never got funded. An unset
 * variable keeps the old fallback, so this only ever narrows the failure.
 */
const transports = Object.fromEntries(
  SUPPORTED_CHAINS.map((entry) => [entry.chain.id, http(entry.rpcEnv || undefined)])
) as Record<number, Transport>;

export const wagmiConfig = getDefaultConfig({
  appName: "Folio",
  // Coinbase Wallet's own connector shows this rather than reading the
  // WalletConnect metadata below, so it is set in both places.
  appIcon: walletConnectMetadata.icons[0],
  projectId: projectId || PLACEHOLDER_PROJECT_ID,
  chains,
  transports,
  ssr: true,
  walletConnectParameters: {
    // RainbowKit builds metadata of its own from `appName`/`appIcon` and passes
    // it here first, so anything set in this object replaces it wholesale. That
    // is the point: its version has no `redirect`, which is the field that
    // sends a phone wallet back to this page after it approves. See
    // lib/walletMetadata.ts.
    metadata: walletConnectMetadata,

    // Do not treat a session as stale just because it was opened before the
    // page knew every chain in SUPPORTED_CHAINS.
    //
    // This is what made a phone wallet report a successful connection while
    // Folio kept showing "Connect wallet". The approval happens in the wallet
    // app, so the browser is in the background for it; phones routinely evict a
    // backgrounded tab, and the page reloads on the way back. wagmi's
    // walletConnect connector writes its `<connector>.requestedChains` key only
    // *after* `provider.connect()` resolves — code that dies with the page. The
    // WalletConnect session itself is already persisted by then, so on reload
    // `reconnect()` finds a live session with accounts, reads an empty
    // requestedChains, concludes the chains are stale, and calls
    // `provider.disconnect()` — tearing down the session the reader had just
    // approved. The wallet is left showing a connection the site has thrown
    // away.
    //
    // With this off, an existing session is adopted as-is. A chain the wallet
    // has not approved is then handled where it belongs: the "Wrong network"
    // button, which asks the wallet to switch or add it.
    isNewChainsStale: false,

    // Turns off the event client in @walletconnect/core, which reports session
    // activity to pulse.walletconnect.org. Nothing here needs it.
    //
    // It does NOT silence every WalletConnect beacon. @walletconnect/
    // ethereum-provider builds a Reown AppKit modal whose own pulse ping fires
    // on provider init — on page load, before the consent banner is answered —
    // and it hardcodes that modal's options, so there is no flag to pass. The
    // only levers are `showQrModal: false` (which would take RainbowKit's QR
    // pairing with it) or not constructing the connector until the reader asks
    // to connect. See the note in README.md.
    telemetryEnabled: false,
  },
});
