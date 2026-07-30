"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWriteContract, useSwitchChain } from "wagmi";
import { parseEther } from "viem";
import { baseSepolia } from "wagmi/chains";
import { useState } from "react";

// Minimal ABI - adjust to match your actual sale contract
const SALE_ABI = [
  {
    name: "buy",
    type: "function",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
] as const;

export default function BuyBar({ token }: { token: any }) {
  const { isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContract, isPending } = useWriteContract();
  const [status, setStatus] = useState<string | null>(null);

  const handleBuy = async () => {
    setStatus(null);
    try {
      // Make sure the wallet is on the same chain as the token
      if (chainId !== baseSepolia.id) {
        await switchChainAsync({ chainId: baseSepolia.id });
      }

      writeContract(
        {
          address: token.contract_address as `0x${string}`,
          abi: SALE_ABI,
          functionName: "buy",
          value: parseEther(String(token.starting_price)),
        },
        {
          onError: (err) => {
            console.error("Buy failed:", err);
            setStatus(
              err.message.includes("User rejected")
                ? "Transaction cancelled."
                : "Transaction failed — this token's contract address is still a placeholder, so there's nothing deployed to buy from yet."
            );
          },
          onSuccess: () => setStatus("Transaction sent!"),
        }
      );
    } catch (err: any) {
      console.error("Buy error:", err);
      setStatus(err.message || "Something went wrong. Check the console.");
    }
  };

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        padding: "14px 20px calc(14px + env(safe-area-inset-bottom))",
        background: "var(--paper)",
        borderTop: "3px double var(--ink)",
      }}
    >
      {status && (
        <div
          className="font-ui"
          style={{ fontSize: 11, color: "var(--ink-soft)", marginBottom: 8 }}
        >
          {status}
        </div>
      )}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div className="font-ui" style={{ fontSize: 10, color: "var(--ink-soft)" }}>
          Price
          <b style={{ display: "block", fontFamily: "PT Serif, serif", fontSize: 16, color: "var(--ink)" }}>
            {token.starting_price} ETH
          </b>
        </div>

        {isConnected ? (
          <button
            onClick={handleBuy}
            disabled={isPending}
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
              cursor: isPending ? "not-allowed" : "pointer",
              opacity: isPending ? 0.6 : 1,
            }}
          >
            {isPending ? "Confirming..." : `Buy $${token.symbol}`}
          </button>
        ) : (
          <ConnectButton />
        )}
      </div>
    </div>
  );
}
