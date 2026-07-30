"use client";

import { useAccount, useConfig } from "wagmi";
import { switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { formatEther, parseEther } from "viem";
import { useMemo, useState } from "react";
import { FOLIO_SALE_ABI } from "@/lib/contracts/folioSale";
import { chainBySlug, explorerAddressUrl } from "@/lib/chains";
import WalletButton from "@/components/WalletButton";
import type { SaleStats, Token } from "@/lib/types";

type Status = { kind: "info" | "error" | "success"; message: string };

export default function BuyBar({ token, stats }: { token: Token; stats: SaleStats }) {
  const { isConnected, chainId } = useAccount();
  const config = useConfig();

  const [amountEth, setAmountEth] = useState(String(token.starting_price));
  const [status, setStatus] = useState<Status | null>(null);
  const [pending, setPending] = useState(false);

  const chainEntry = chainBySlug(token.chain);
  const soldOut = stats.onChain && stats.sold >= stats.supply && stats.supply > 0;

  const parsed = useMemo(() => {
    const value = Number(amountEth);
    if (!amountEth.trim() || !Number.isFinite(value) || value <= 0) return null;
    try {
      return parseEther(amountEth.trim());
    } catch {
      return null;
    }
  }, [amountEth]);

  // Mirrors the contract: tokens = value * 1e18 / price, capped at what's left.
  const tokensOut = useMemo(() => {
    if (parsed === null) return null;
    const price = Number(token.starting_price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const wanted = Number(formatEther(parsed)) / price;
    const available = stats.onChain ? Math.max(0, stats.supply - stats.sold) : Infinity;
    return Math.min(wanted, available);
  }, [parsed, token.starting_price, stats]);

  const handleBuy = async () => {
    setStatus(null);

    if (!chainEntry) {
      setStatus({
        kind: "error",
        message: `This token is on an unsupported network ("${token.chain}").`,
      });
      return;
    }
    if (parsed === null || parsed === 0n) {
      setStatus({ kind: "error", message: "Enter how much ETH you want to spend." });
      return;
    }

    setPending(true);
    try {
      // Switch to the chain this token was actually deployed on, not a
      // hardcoded default.
      if (chainId !== chainEntry.chain.id) {
        await switchChain(config, { chainId: chainEntry.chain.id }).catch(() => {
          throw new Error(`Switch your wallet to ${chainEntry.chain.name} to buy.`);
        });
      }

      const hash = await writeContract(config, {
        address: token.contract_address as `0x${string}`,
        abi: FOLIO_SALE_ABI,
        functionName: "buy",
        value: parsed,
        chainId: chainEntry.chain.id,
      });

      setStatus({ kind: "info", message: "Transaction sent, waiting for confirmation..." });
      const receipt = await waitForTransactionReceipt(config, {
        hash,
        chainId: chainEntry.chain.id,
      });

      if (receipt.status === "success") {
        setStatus({ kind: "success", message: `Bought $${token.symbol}. Reload to see updated totals.` });
      } else {
        setStatus({ kind: "error", message: "The transaction reverted. No tokens were bought." });
      }
    } catch (err) {
      console.error("Buy failed:", err);
      setStatus({ kind: "error", message: describeBuyError(err) });
    } finally {
      setPending(false);
    }
  };

  const explorer = explorerAddressUrl(token.chain, token.contract_address);

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        padding: "12px 20px calc(12px + env(safe-area-inset-bottom))",
        background: "var(--paper)",
        borderTop: "3px double var(--ink)",
      }}
    >
      {status && (
        <div
          className="font-ui"
          role="status"
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            marginBottom: 8,
            color: status.kind === "error" ? "#b00020" : "var(--ink-soft)",
            wordBreak: "break-word",
          }}
        >
          {status.message}
        </div>
      )}

      {!stats.onChain && (
        <div className="font-ui" style={{ fontSize: 10.5, color: "var(--ink-soft)", marginBottom: 8 }}>
          Live sale data unavailable — this listing may predate on-chain deployment
          {explorer && (
            <>
              {" · "}
              <a href={explorer} target="_blank" rel="noopener noreferrer">
                view contract
              </a>
            </>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span className="font-ui" style={{ fontSize: 9, letterSpacing: 1, color: "var(--ink-soft)" }}>
            SPEND (ETH)
          </span>
          <input
            type="number"
            min="0"
            step="0.0001"
            inputMode="decimal"
            value={amountEth}
            onChange={(e) => setAmountEth(e.target.value)}
            disabled={pending || soldOut}
            style={{
              width: 96,
              padding: "9px 8px",
              border: "1px solid var(--rule)",
              fontFamily: "PT Serif, serif",
              fontSize: 14,
            }}
          />
        </label>

        {isConnected ? (
          <button
            onClick={handleBuy}
            disabled={pending || soldOut || parsed === null}
            className="font-ui"
            style={{
              flex: 1,
              padding: "14px 0",
              background: "var(--ink)",
              color: "var(--paper)",
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 1,
              border: "none",
              cursor: pending || soldOut || parsed === null ? "not-allowed" : "pointer",
              opacity: pending || soldOut || parsed === null ? 0.6 : 1,
            }}
          >
            {soldOut ? "Sold out" : pending ? "Confirming..." : `Buy $${token.symbol}`}
          </button>
        ) : (
          <div style={{ flex: 1 }}>
            <WalletButton variant="block" />
          </div>
        )}
      </div>

      <div className="font-ui" style={{ fontSize: 10.5, color: "var(--ink-soft)", marginTop: 6 }}>
        {token.starting_price} ETH per token
        {tokensOut !== null && tokensOut > 0 && (
          <> · you receive ≈ {tokensOut.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${token.symbol}</>
        )}
      </div>
    </div>
  );
}

function describeBuyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (/User rejected|User denied|rejected the request/i.test(message)) {
    return "Transaction cancelled.";
  }
  if (/insufficient funds/i.test(message)) {
    return "Not enough ETH in your wallet to cover the purchase plus gas.";
  }
  if (/SoldOut/.test(message)) {
    return "This sale is sold out.";
  }
  if (/PaymentTooSmall/.test(message)) {
    return "That amount is too small to buy any tokens.";
  }
  // A listing whose contract_address has no contract behind it — e.g. a row
  // created before real deployment was wired up.
  if (/returned no data|does not exist|is not a contract/i.test(message)) {
    return "There's no sale contract at this address, so there's nothing to buy.";
  }
  return message.split("\n")[0] || "Something went wrong. Check the console.";
}
