import { getDefaultConfig, getDefaultWallets } from "@rainbow-me/rainbowkit";
import type { WalletList } from "@rainbow-me/rainbowkit";
import { coinbaseWallet, injectedWallet, safeWallet } from "@rainbow-me/rainbowkit/wallets";
import { fallback, http, type Chain, type Transport } from "viem";
import { DEFAULT_CHAIN_SLUG, SUPPORTED_CHAINS, chainBySlug, rpcProxyPath } from "./chains";
import {
  WALLET_BOOT_MODAL,
  WALLET_BOOT_PANEL,
  bootWallets,
  onWalletBoot,
  walletBootLevel,
} from "./walletBoot";
import { walletConnectMetadata } from "./walletMetadata";
import { hasStoredWalletConnectSession } from "./walletSession";

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
 *
 * Behind it, in the browser only, sits Folio's own origin — see
 * `app/api/rpc/[slug]/route.ts`. Rate limiting is not the only way a read
 * fails: a phone whose network filters the RPC's domain, or an in-app browser
 * whose WebView cannot resolve it, or a middlebox answering the POST with a
 * block page, all produce a balance that never resolves no matter how good the
 * endpoint above is, on a wallet the reader can see the ETH in. Those are the
 * reports this is for. The relay is reached at the host the page itself came
 * from, which is the one host that is known to work, because the page is on
 * screen.
 *
 * Order is the whole design. The direct endpoint is tried first and a healthy
 * browser never leaves it, so the relay costs nothing in the ordinary case and
 * carries traffic only for the readers who would otherwise see nothing at all.
 * viem's `fallback` moves on for transport failures and HTTP errors, and
 * rethrows a JSON-RPC error rather than re-asking a second endpoint a question
 * the first one answered.
 *
 * Server-side there is no relay in the list, and it would be wrong to add one:
 * a relative URL has no meaning in Node, this code runs *in* the process that
 * serves that route, and a server that cannot reach the RPC gains nothing by
 * asking itself.
 */
const transports = Object.fromEntries(
  SUPPORTED_CHAINS.map((entry) => {
    const direct = http(entry.rpcEnv || undefined);
    if (typeof window === "undefined") return [entry.chain.id, direct];

    return [
      entry.chain.id,
      // Absolute, from the page's own origin. viem hands a relative URL to
      // fetch untouched and the browser would resolve it the same way — but
      // only if nothing on the page has moved the base, and a URL that has to
      // be right for the fallback to mean anything should not depend on that.
      fallback([direct, http(`${window.location.origin}${rpcProxyPath(entry.slug)}`)], {
        // The transports inside a fallback are each given `retryCount: 0` by
        // viem, so this is the only retry ladder in play: one more pass over
        // both endpoints, then the error reaches the caller. Deliberately
        // short. Everything reading a balance is on a timer that will ask again
        // shortly, and useGasBalance stops calling a read "checking" after
        // fifteen seconds — a ladder longer than that patience just guarantees
        // the answer lands after the page has given up on it.
        retryCount: 1,
      }),
    ];
  })
) as Record<number, Transport>;

/**
 * The wallets the connect modal offers when there is no WalletConnect relay to
 * offer them over.
 *
 * RainbowKit's default list is mostly phone wallets, and every one of them
 * pairs over WalletConnect. Without a project ID that pairing cannot happen —
 * but the modal still lists them, so pressing one opens a wallet that then
 * fails on its own terms, which is why the failure reads as "not supported"
 * rather than as a missing setting. Listing only what can actually connect is
 * the honest version of that modal:
 *
 *  - `injectedWallet` — an extension, or a wallet's own in-app browser, which
 *    is the route WalletHandoff points a phone at.
 *  - `coinbaseWallet` — its own SDK, no relay involved.
 *  - `safeWallet` — only appears inside a Safe app frame, and costs nothing
 *    elsewhere.
 *
 * Only used when there is no project ID. With one, the list is RainbowKit's
 * own default, unchanged apart from every wallet in it going through
 * deferBoot below.
 */
const relaylessWallets: WalletList = [
  { groupName: "Available here", wallets: [injectedWallet, coinbaseWallet, safeWallet] },
];

/** One entry in a WalletList. RainbowKit names this `CreateWalletFn` but does
 *  not export it from the package root, so it is read off the list instead. */
type CreateWalletFn = WalletList[number]["wallets"][number];

/**
 * The same wallet, built only once somebody might want it.
 *
 * Two hooks are moved, and they are the two ways a wallet SDK ends up being
 * downloaded by a reader who is only reading:
 *
 *  - `setup()`, which wagmi calls on every connector from inside
 *    `createConfig` — before React has mounted, on every page of the site. For
 *    the connectors that define one it is a megabyte of SDK away, because it
 *    awaits `getProvider()`, and the work it then does with that provider is
 *    subscribing to two events. Nothing reads its result, `connect()` fetches
 *    its own provider, and wagmi never checks whether it ran, so it is safe to
 *    hold until the reader is heading for the wallet.
 *
 *  - `getProvider()` itself, which wagmi's mount-time `reconnect()` calls on
 *    every connector in the list to find out whether any of them is holding a
 *    session. Answering that question honestly costs the whole SDK. Answering
 *    it with `undefined` costs nothing and is a shape wagmi already handles —
 *    it is what a connector with no provider available returns, and `reconnect`
 *    skips it and moves on.
 *
 * So a cold connector says it has nothing, *unless* storage says otherwise:
 * `recentConnectorId` is wagmi's own note of the connector this reader last
 * connected with, and a stored WalletConnect session is the phone-handoff case
 * where the approval landed while the page was dead and there was never a
 * chance to write that note (see lib/walletSession.ts). Either one means this
 * reader has a wallet to restore, so the SDK is fetched at once and the
 * restore happens exactly as it did before.
 *
 * RainbowKit's second WalletConnect connector waits a step longer than the
 * rest. It exists so a reader can open WalletConnect's own modal instead of
 * RainbowKit's QR view, and it is the only thing in the app that pulls in
 * `@reown/appkit` — half a megabyte, plus a telemetry ping to
 * pulse.walletconnect.org that fires on init and therefore used to fire on
 * every page load, before the cookie banner had been answered. It is released
 * when the connect modal opens, which is the tap before the one that needs it.
 *
 * Nothing above can leave a connect waiting on a level that was never
 * released: `connect` and `getChainId` — the two calls RainbowKit makes when a
 * reader picks a wallet — open every level themselves before delegating.
 *
 * The replacements are written as methods rather than arrows because `this`
 * matters: `setup` reaches for `this.getProvider()` and `this.onConnect`, and
 * those live on the object wagmi assembles from this one, not on this one.
 */
function deferBoot(createWallet: CreateWalletFn): CreateWalletFn {
  return (options) => {
    const wallet = createWallet(options);
    const createConnector = wallet.createConnector;

    return {
      ...wallet,
      createConnector: (walletDetails) => {
        const connectorFn = createConnector(walletDetails);
        // The `@reown/appkit` one. Everything else is wanted a step earlier.
        const appKit = walletDetails.rkDetails.isWalletConnectModalConnector === true;
        const level = appKit ? WALLET_BOOT_MODAL : WALLET_BOOT_PANEL;
        // Which of RainbowKit's two WalletConnect clients this connector's
        // sessions belong to — see getWalletConnectConnector, which sets the
        // prefix, and hasStoredWalletConnectSession, which reads it.
        const sessionPrefix = appKit ? "clientOne" : "clientTwo";

        return (config) => {
          const connector = connectorFn(config);
          const { setup, getProvider, getChainId, connect } = connector;

          // Two connectors are left alone, because holding them back would
          // cost something and save nothing. An injected wallet's provider is
          // `window.ethereum`, already in the page; Safe's is a small module
          // that only resolves inside Safe's own frame, and a Safe app is
          // expected to be connected the moment it opens, with nobody there to
          // press anything. Everything else here is a wallet SDK measured in
          // hundreds of kilobytes.
          const cheap = connector.type === "injected" || connector.type === "safe";
          if (cheap) return connector;

          /**
           * Has this reader a session that belongs to *this* connector?
           *
           * A WalletConnect connector is asked about its own session store,
           * not about wagmi's `recentConnectorId`: both of RainbowKit's
           * WalletConnect connectors answer to the id `walletConnect`, so that
           * note cannot tell them apart, and treating it as a match for both
           * would build the expensive one for every reader who ever paired
           * over the cheap one. Everything else has an id of its own, and
           * `recentConnectorId` is wagmi's own record of which connector this
           * reader last connected with.
           */
          const restoring = async () => {
            if (connector.type === "walletConnect") {
              return hasStoredWalletConnectSession(sessionPrefix);
            }
            try {
              return (await config.storage?.getItem("recentConnectorId")) === connector.id;
            } catch {
              // Storage can be unavailable. Then there is nothing to restore.
              return false;
            }
          };

          // Cast because `connect` is generic over `withCapabilities` and a
          // wrapper cannot carry a type parameter through `apply`. The shape
          // is the connector's own, minus that one inference.
          return {
            ...connector,

            ...(setup
              ? {
                  // `async` only to satisfy wagmi's signature: the point of
                  // this one is that it returns without having done the work.
                  async setup() {
                    const self = this;
                    onWalletBoot(level, () => {
                      void Promise.resolve(setup.call(self)).catch(() => undefined);
                    });
                  },
                }
              : {}),

            async getProvider(...args: Parameters<typeof getProvider>) {
              if (walletBootLevel() < level && !(await restoring())) {
                // "Nothing here" — see above. Cast because wagmi's types
                // describe a provider that always exists, and the runtime,
                // which is what `reconnect` is written against, does not.
                return undefined as unknown as ReturnType<typeof getProvider>;
              }
              return getProvider.apply(this, args);
            },

            async getChainId(...args: Parameters<typeof getChainId>) {
              bootWallets(WALLET_BOOT_MODAL);
              return getChainId.apply(this, args);
            },

            async connect(...args: Parameters<typeof connect>) {
              bootWallets(WALLET_BOOT_MODAL);
              return connect.apply(this, args);
            },
          } as typeof connector;
        };
      },
    };
  };
}

/** Every wallet in a list, deferred. */
function deferred(wallets: WalletList): WalletList {
  return wallets.map((group) => ({
    ...group,
    wallets: group.wallets.map(deferBoot),
  }));
}

/**
 * The chain a wallet must agree to before a WalletConnect pairing counts.
 *
 * Everything wagmi proposes is *optional*: it passes `optionalChains` and no
 * `chains`, so the proposal carries no required namespace at all. A wallet that
 * has never heard of Robinhood Chain is free to approve the session anyway, on
 * whatever networks it does have — and it does, because the connect sheet in
 * most phone wallets is an approve button, not a network picker. What comes
 * back is a session whose namespaces name only Ethereum Mainnet, which is a
 * connection Folio cannot use for anything: the approved namespaces are fixed
 * at pairing time, so no later `wallet_switchEthereumChain` can widen them.
 *
 * Naming a chain here puts it in `requiredNamespaces` instead, which changes
 * two things. The wallet must approve that chain or refuse the whole session —
 * no more silent landing on mainnet. And @walletconnect/ethereum-provider then
 * takes the session's chain id from this list rather than from whichever
 * account the wallet happened to return first, which is the other half of how
 * a Robinhood Chain pairing used to come back reporting chain 1.
 *
 * The cost is real and worth stating plainly: a wallet without this chain now
 * declines the connection outright, where before it produced a connection that
 * merely did not work. That is the better failure — it happens in the wallet,
 * at the moment of asking, instead of three screens later — but it is still a
 * failure, and the wallets that have never added an Orbit chain like this one
 * are exactly the ones readers arrive with. WalletHandoff says so on the way
 * past, and the
 * route it offers (open Folio inside the wallet's own browser) does not involve
 * a pairing at all.
 *
 * `NEXT_PUBLIC_WALLETCONNECT_REQUIRED_CHAIN` sets it. Any other supported slug
 * moves the requirement; `none` removes it and restores the all-optional
 * proposal above. Unset means the default chain, which is the one every
 * launch-less page is about.
 *
 * Only this chain is required. The rest of SUPPORTED_CHAINS stays in the
 * optional namespace, so a wallet that has them approves them too and a token
 * on another network still trades without a second pairing. There is one
 * supported chain today, which makes the required set and the optional set the
 * same single network.
 */
const requiredChainSetting =
  process.env.NEXT_PUBLIC_WALLETCONNECT_REQUIRED_CHAIN || DEFAULT_CHAIN_SLUG;

const requiredChain =
  requiredChainSetting === "none" ? undefined : chainBySlug(requiredChainSetting)?.chain;

/** The network a wallet is asked to commit to at pairing, for the UI that has
 *  to explain a refusal. Undefined when nothing is required. */
export const requiredChainName = requiredChain?.name;

if (!requiredChain && requiredChainSetting !== "none" && typeof window !== "undefined") {
  console.warn(
    `NEXT_PUBLIC_WALLETCONNECT_REQUIRED_CHAIN is "${requiredChainSetting}", which ` +
      "is not a supported chain slug. No chain will be required at pairing — set " +
      "it to a slug from SUPPORTED_CHAINS, or to `none` to mean that on purpose."
  );
}

/**
 * `chains` is the required namespace, and wagmi's own types omit it — the
 * connector means to own that field. It does not, quite: `getProvider` spreads
 * these parameters into `EthereumProvider.init` *before* setting its own keys,
 * and `optionalChains` is the only one of the two it names. So `chains` reaches
 * the provider untouched, and the cast is the honest way to say that this leans
 * on a gap the type describes as closed. Pinned versions in package.json; if a
 * bump starts overriding `chains` too, the requirement silently stops applying
 * and pairings go back to landing on mainnet.
 */
const walletConnectParameters = {
  // RainbowKit builds metadata of its own from `appName`/`appIcon` and passes
  // it here first, so anything set in this object replaces it wholesale. That
  // is the point: its version has no `redirect`, which is the field that
  // sends a phone wallet back to this page after it approves. See
  // lib/walletMetadata.ts.
  metadata: walletConnectMetadata,

  ...(requiredChain ? { chains: [requiredChain.id] } : {}),

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
  // With this off, an existing session is adopted as-is. A session that
  // predates the requirement above is therefore still adopted, mainnet and
  // all — wagmi does not re-propose over a session whose chains overlap ours
  // not at all. That is what the connect button's "Reconnect wallet" is for.
  isNewChainsStale: false,

  // Turns off the event client in @walletconnect/core, which reports session
  // activity to pulse.walletconnect.org. Nothing here needs it.
  //
  // It does NOT silence every WalletConnect beacon. @walletconnect/
  // ethereum-provider builds a Reown AppKit modal whose own pulse ping fires
  // on provider init, and it hardcodes that modal's options, so there is no
  // flag to pass. That ping used to happen on page load, before the consent
  // banner was answered; the lever taken against it is the last one available
  // — the connector is not constructed until the reader asks for a wallet.
  // See deferBoot above, and lib/walletBoot.ts.
  telemetryEnabled: false,
} as Parameters<typeof getDefaultConfig>[0]["walletConnectParameters"];

export const wagmiConfig = getDefaultConfig({
  appName: "Folio",
  // RainbowKit's own default list when there is a relay to reach the phone
  // wallets over, asked for by name rather than left to the `undefined`
  // default so every wallet in it can go through deferBoot above.
  wallets: deferred(
    hasWalletConnectProjectId ? getDefaultWallets().wallets : relaylessWallets
  ),
  // Coinbase Wallet's own connector shows this rather than reading the
  // WalletConnect metadata below, so it is set in both places.
  appIcon: walletConnectMetadata.icons[0],
  projectId: projectId || PLACEHOLDER_PROJECT_ID,
  chains,
  transports,
  ssr: true,
  walletConnectParameters,
});
