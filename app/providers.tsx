"use client";

import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmiConfig";
import { folioWalletTheme } from "@/lib/walletTheme";
import { chainBySlug } from "@/lib/chains";
import { usePreferredChainSlug } from "@/lib/preferredChain";
import CurrencyProvider from "@/components/CurrencyProvider";
import ChainSync from "@/components/ChainSync";
import WalletSessionSync from "@/components/WalletSessionSync";
import { useState } from "react";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  // The chain a connect request should ask for. RainbowKit passes it to
  // `connect({ chainId })`, so a wallet sitting on mainnet is asked to move as
  // part of the same approval the reader is already looking at, instead of
  // connecting and then being told it is on the wrong network. Pages declare
  // this — see lib/preferredChain.ts.
  const initialChain = chainBySlug(usePreferredChainSlug())?.chain;

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={folioWalletTheme}
          appInfo={{ appName: "Folio" }}
          initialChain={initialChain}
        >
          {/* Renders nothing; picks up a session approved in a wallet app
              while this page was frozen in the background. */}
          <WalletSessionSync />
          {/* Also nothing; moves a wallet off a chain Folio cannot use. */}
          <ChainSync />
          {/* Inside the query client: the ETH price is polled through it. */}
          <CurrencyProvider>{children}</CurrencyProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
