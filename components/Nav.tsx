"use client";

import Link from "next/link";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";

export default function Nav() {
  const { isConnected, address } = useAccount();

  return (
    <div
      className="font-ui"
      style={{
        maxWidth: 640,
        margin: "0 auto",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 20px",
        borderBottom: "1px solid var(--rule)",
        fontSize: 11,
      }}
    >
      <Link href="/" style={{ fontWeight: 700, letterSpacing: 1 }}>
        FOLIO
      </Link>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {isConnected && (
          <Link href="/profile" style={{ color: "var(--ink-soft)" }}>
            {address?.slice(0, 6)}...{address?.slice(-4)}
          </Link>
        )}
        <div style={{ transform: "scale(0.85)", transformOrigin: "right center" }}>
          <ConnectButton showBalance={false} chainStatus="none" />
        </div>
      </div>
    </div>
  );
}
