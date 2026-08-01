"use client";

import { useAccount } from "wagmi";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import WalletButton from "@/components/WalletButton";
import WalletHandoff from "@/components/WalletHandoff";
import Mark from "@/components/Mark";
import { supabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import { chainLabel } from "@/lib/chains";
import {
  formatAmount,
  formatDateShort,
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
      <main id="main" className="shell shell--measure page">
        <div className="empty">
          <p className="eyebrow" style={{ marginBottom: "var(--sp-3)" }}>
            Staff page
          </p>
          <p style={{ marginBottom: "var(--sp-5)" }}>
            Connect your wallet to see the launches published from it.
          </p>
          <div style={{ maxWidth: "18rem", margin: "0 auto" }}>
            <WalletButton variant="block" />
            {/* Renders nothing unless connecting from this browser is the
                thing that will not work. */}
            <div style={{ marginTop: "var(--sp-3)", textAlign: "left" }}>
              <WalletHandoff />
            </div>
          </div>
        </div>
      </main>
    );
  }

  const totalSupplyIssued = tokens.reduce((sum, t) => sum + toNumber(t.supply), 0);
  const totalSold = tokens.reduce((sum, t) => sum + toNumber(t.sold_amount), 0);

  return (
    <main id="main" className="shell page">
      <header style={{ marginBottom: "var(--sp-5)" }}>
        <p className="eyebrow">Staff page</p>
        <h1
          className="mono"
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 900,
            fontSize: "var(--fs-h1)",
            margin: "var(--sp-2) 0 var(--sp-1)",
          }}
        >
          {shortAddress(address)}
        </h1>
        <p className="eyebrow">{chain?.name || "Unknown network"}</p>
      </header>

      <div className="stats" style={{ marginBottom: "var(--sp-7)" }}>
        {(
          [
            ["Tokens published", formatAmount(tokens.length)],
            ["Total supply issued", formatAmount(totalSupplyIssued)],
            ["Total sold", formatAmount(totalSold)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="stat">
            <div className="stat__label">{label}</div>
            <div className="stat__value">{value}</div>
          </div>
        ))}
      </div>

      <div className="section-head">
        <h2 className="eyebrow">Byline — published tokens</h2>
      </div>

      {loading && <p className="muted">Loading...</p>}

      {error && (
        <div className="notice notice--alert" role="alert">
          {error}
        </div>
      )}

      {!loading && !error && tokens.length === 0 && (
        <div className="empty">
          <p style={{ marginBottom: "var(--sp-4)" }}>
            You haven&apos;t published a token yet.
          </p>
          <Link href="/create" className="btn btn--primary">
            Launch one
          </Link>
        </div>
      )}

      {tokens.length > 0 && (
        <div className="feed">
          {tokens.map((t) => (
            <Link key={t.id} href={`/token/${t.contract_address}`} className="card">
              <div className="card__meta">
                <Mark src={t.avatar_url} symbol={t.symbol} name={t.name} size="sm" />
                <span className="card__kicker">
                  {chainLabel(t.chain)} · ${t.symbol}
                </span>
              </div>

              <h3 className="card__title">{t.article_title || t.name}</h3>

              <div className="card__foot">
                <span className="nums">
                  {formatPercent(percentSold(toNumber(t.sold_amount), toNumber(t.supply)))} sold
                </span>
                <span className="nums">{formatDateShort(t.created_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}

function toNumber(value: number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
