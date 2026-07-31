import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import type { Chain } from "viem";
import { SUPPORTED_CHAINS } from "./chains";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

// RainbowKit throws from getDefaultConfig when projectId is missing, and this
// module is imported by the root layout — so an unset variable failed
// `next build` while prerendering, before any page could render. Fall back to a
// placeholder instead: injected wallets (MetaMask, Rabby, Coinbase extension)
// still connect, and only WalletConnect's QR pairing needs a real ID.
if (!projectId && typeof window !== "undefined") {
  console.warn(
    "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set. WalletConnect QR pairing " +
      "is disabled; browser-extension wallets still work. Get a free project ID " +
      "at cloud.walletconnect.com (see .env.example)."
  );
}

// Non-empty by construction; getDefaultConfig wants a non-empty tuple.
const chains = SUPPORTED_CHAINS.map((entry) => entry.chain) as unknown as readonly [
  Chain,
  ...Chain[],
];

export const wagmiConfig = getDefaultConfig({
  appName: "Folio",
  projectId: projectId || "00000000000000000000000000000000",
  chains,
  ssr: true,
  walletConnectParameters: {
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
