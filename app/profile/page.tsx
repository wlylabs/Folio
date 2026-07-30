"use client";

import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import { chainLabel } from "@/lib/chains";
import {
  formatAmount,
  formatPercent,
  percentSold,
  shortAddress,
  type Token,
} from "@/lib/types";

export default function ProfilePage() {
  const { address, isConnected, chain } = useAccount();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (wallet: string) => {
    setLoading(true);
    setError(null);
    try {
      // creator_wallet is stored lowercased, but older rows may carry checksum
      // casing, so match case-insensitively.
      const { data, error: queryError } = await supabase
        .from("tokens")
        .select("*")
        .ilike("creator_wallet", wallet)
        .order("created_at", { ascending: false });

      if (queryError) throw new Error(queryError.message);
      setTokens((data as Token[]) ?? []);
    } catch (err) {
      console.error("Failed to load your tokens:", err);
      setError(err instanceof Error ? err.message : "Could not load your tokens.");
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!address || !isSupabaseConfigured) {
      setTokens([]);
      setLoading(false);
      return;
    }
    void load(address);
  }, [address, load]);

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

  const totalSupplyIssued = tokens.reduce((sum, t) => sum + toNumber(t.supply), 0);
  const totalSold = tokens.reduce((sum, t) => sum + toNumber(t.sold_amount), 0);

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", paddingBottom: 60 }}>
      <div style={{ padding: "20px 20px 0" }}>
        <div className="font-ui" style={{ fontSize: 9.5, letterSpacing: 2, color: "var(--ink-soft)" }}>
          STAFF PAGE
        </div>
        <h1
          className="font-display"
          style={{ fontWeight: 900, fontSize: 26, margin: "8px 0 4px", wordBreak: "break-all" }}
        >
          {shortAddress(address)}
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
          {(
            [
              ["Tokens published", formatAmount(tokens.length)],
              ["Total supply issued", formatAmount(totalSupplyIssued)],
              ["Total sold", formatAmount(totalSold)],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
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

      <div
        className="font-ui"
        style={{
          padding: "0 20px 10px",
          fontSize: 10,
          letterSpacing: 2.5,
          color: "var(--ink-soft)",
        }}
      >
        BYLINE — PUBLISHED TOKENS
      </div>

      {loading && <p style={{ padding: "0 20px", color: "var(--ink-soft)" }}>Loading...</p>}

      {error && (
        <p className="font-ui" role="alert" style={{ padding: "0 20px", fontSize: 12, color: "#b00020" }}>
          {error}
        </p>
      )}

      {!loading && !error && tokens.length === 0 && (
        <p style={{ padding: "0 20px", color: "var(--ink-soft)", lineHeight: 1.7 }}>
          You haven&apos;t published a token yet. <Link href="/create">Launch one</Link>.
        </p>
      )}

      {tokens.map((t) => (
        <Link
          key={t.id}
          href={`/token/${t.contract_address}`}
          style={{ textDecoration: "none", color: "inherit", display: "block" }}
        >
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--rule)" }}>
            <div className="font-ui" style={{ fontSize: 9, color: "var(--ink-soft)" }}>
              {chainLabel(t.chain)} · ${t.symbol} · Sold{" "}
              {formatPercent(percentSold(toNumber(t.sold_amount), toNumber(t.supply)))}
            </div>
            <div className="font-display" style={{ fontWeight: 700, fontSize: 18 }}>
              {t.article_title || t.name}
            </div>
          </div>
        </Link>
      ))}
    </main>
  );
}

function toNumber(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
