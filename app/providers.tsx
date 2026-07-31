"use client";

import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmiConfig";
import { folioWalletTheme } from "@/lib/walletTheme";
import CurrencyProvider from "@/components/CurrencyProvider";
import WalletSessionSync from "@/components/WalletSessionSync";
import { useState } from "react";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={folioWalletTheme} appInfo={{ appName: "Folio" }}>
          {/* Renders nothing; picks up a session approved in a wallet app
              while this page was frozen in the background. */}
          <WalletSessionSync />
          {/* Inside the query client: the ETH price is polled through it. */}
          <CurrencyProvider>{children}</CurrencyProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
