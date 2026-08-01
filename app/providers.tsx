"use client";

import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmiConfig";
import { walletThemeFor } from "@/lib/walletTheme";
import { chainBySlug } from "@/lib/chains";
import { usePreferredChainSlug } from "@/lib/preferredChain";
import CurrencyProvider from "@/components/CurrencyProvider";
import ThemeProvider, { useTheme } from "@/components/ThemeProvider";
import ChainSync from "@/components/ChainSync";
import WalletSessionSync from "@/components/WalletSessionSync";
import { useState } from "react";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    // Outermost, so the settings panel and the wallet modal read the same
    // answer. It renders no colour of its own — the palette is on the document
    // before React starts (see lib/theme.ts) — so nothing below it flashes
    // while this catches up on the first client pass.
    <ThemeProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <WalletChrome>
            {/* Renders nothing; picks up a session approved in a wallet app
                while this page was frozen in the background. */}
            <WalletSessionSync />
            {/* Also nothing; moves a wallet off a chain Folio cannot use. */}
            <ChainSync />
            {/* Inside the query client: the ETH price is polled through it. */}
            <CurrencyProvider>{children}</CurrencyProvider>
          </WalletChrome>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}

/**
 * RainbowKit, dressed in whichever palette the page is in.
 *
 * Its own component because the theme has to be read from context, and context
 * can only be read below the provider that supplies it — `Providers` above is
 * the thing mounting ThemeProvider, so it cannot also be the thing consuming
 * it.
 */
function WalletChrome({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();

  // The chain a connect request should ask for. RainbowKit passes it to
  // `connect({ chainId })`, so a wallet sitting on mainnet is asked to move as
  // part of the same approval the reader is already looking at, instead of
  // connecting and then being told it is on the wrong network. Pages declare
  // this — see lib/preferredChain.ts.
  const initialChain = chainBySlug(usePreferredChainSlug())?.chain;

  return (
    <RainbowKitProvider
      theme={walletThemeFor(theme)}
      appInfo={{ appName: "Folio" }}
      initialChain={initialChain}
    >
      {children}
    </RainbowKitProvider>
  );
}
