"use client";

import Link from "next/link";
import { useAccount } from "wagmi";
import WalletButton from "@/components/WalletButton";

export default function Nav() {
  const { isConnected } = useAccount();

  return (
    <div
      className="font-ui"
      style={{
        maxWidth: 640,
        margin: "0 auto",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        padding: "10px 20px",
        borderBottom: "1px solid var(--rule)",
        fontSize: 11,
      }}
    >
      <Link href="/" style={{ fontWeight: 700, letterSpacing: 1 }}>
        FOLIO
      </Link>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Link href="/create" style={{ color: "var(--ink-soft)" }}>
          Launch
        </Link>
        {isConnected && (
          // The wallet chip carries the address now, so this links by name
          // instead of repeating it.
          <Link href="/profile" style={{ color: "var(--ink-soft)" }}>
            Staff
          </Link>
        )}
        <WalletButton variant="nav" />
      </div>
    </div>
  );
}
