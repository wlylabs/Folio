"use client";

import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";

export default function ProfilePage() {
  const { address, isConnected, chain } = useAccount();
  const [tokens, setTokens] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("tokens")
        .select("*")
        .eq("creator_wallet", address)
        .order("created_at", { ascending: false });
      if (!error) setTokens(data || []);
      setLoading(false);
    })();
  }, [address]);

  if (!isConnected) {
    return (
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "60px 20px", textAlign: "center" }}>
        <p className="font-ui" style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 16 }}>
          Connect your wallet to view your staff page.
        </p>
        <ConnectButton />
      </main>
    );
  }

  const totalSupplyIssued = tokens.reduce((sum, t) => sum + Number(t.supply || 0), 0);
  const totalSold = tokens.reduce((sum, t) => sum + Number(t.sold_amount || 0), 0);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", paddingBottom: 60 }}>
      <div style={{ padding: "20px 20px 0" }}>
        <div className="font-ui" style={{ fontSize: 9.5, letterSpacing: 2, color: "var(--ink-soft)" }}>
          STAFF PAGE
        </div>
        <h1 className="font-display" style={{ fontWeight: 900, fontSize: 26, margin: "8px 0 4px", wordBreak: "break-all" }}>
          {address?.slice(0, 6)}...{address?.slice(-4)}
        </h1>
        <div className="font-ui" style={{ fontSize: 10, color: "var(--ink-soft)", marginBottom: 16 }}>
          {chain?.name || "Unknown network"}
        </div>

        <div style={{ border: "1px solid var(--ink)", marginBottom: 24 }}>
          <div
            className="font-ui"
            style={{
              fontSize: 9.5,
              letterSpacing: 2,
              background: "var(--ink)",
              color: "var(--paper)",
              padding: "8px 12px",
            }}
          >
            CONTRIBUTOR STATS
          </div>
          {[
            ["Tokens published", tokens.length],
            ["Total supply issued", totalSupplyIssued.toLocaleString()],
            ["Total sold", totalSold.toLocaleString()],
          ].map(([label, value]) => (
            <div
              key={label as string}
              className="font-ui"
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "9px 12px",
                borderBottom: "1px solid var(--rule)",
                fontSize: 11.5,
              }}
            >
              <span style={{ color: "var(--ink-soft)" }}>{label}</span>
              <span style={{ fontWeight: 600 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="font-ui" style={{ padding: "0 20px 10px", fontSize: 10, letterSpacing: 2.5, color: "var(--ink-soft)" }}>
        BYLINE — PUBLISHED TOKENS
      </div>

      {loading && (
        <p style={{ padding: "0 20px", color: "var(--ink-soft)" }}>Loading...</p>
      )}

      {!loading && tokens.length === 0 && (
        <p style={{ padding: "0 20px", color: "var(--ink-soft)" }}>
          You haven't published a token yet. <Link href="/create">Launch one</Link>.
        </p>
      )}

      {tokens.map((t) => {
        const sold = t.supply ? ((t.sold_amount / t.supply) * 100).toFixed(1) : "0.0";
        return (
          <Link key={t.id} href={`/token/${t.contract_address}`} style={{ textDecoration: "none", color: "inherit" }}>
            <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--rule)" }}>
              <div className="font-ui" style={{ fontSize: 9, color: "var(--ink-soft)" }}>
                {t.chain.toUpperCase()} · ${t.symbol} · Sold {sold}%
              </div>
              <div className="font-display" style={{ fontWeight: 700, fontSize: 18 }}>
                {t.article_title || t.name}
              </div>
            </div>
          </Link>
        );
      })}
    </main>
  );
}
