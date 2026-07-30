"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useWriteContract } from "wagmi";
import { parseEther } from "viem";

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
  const { isConnected } = useAccount();
  const { writeContract, isPending } = useWriteContract();

  const handleBuy = () => {
    writeContract({
      address: token.contract_address as `0x${string}`,
      abi: SALE_ABI,
      functionName: "buy",
      value: parseEther(String(token.starting_price)),
    });
  };

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        padding: "14px 20px calc(14px + env(safe-area-inset-bottom))",
        background: "var(--paper)",
        borderTop: "3px double var(--ink)",
        display: "flex",
        gap: 12,
        alignItems: "center",
      }}
    >
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
            cursor: "pointer",
          }}
        >
          {isPending ? "Confirming..." : `Buy $${token.symbol}`}
        </button>
      ) : (
        <ConnectButton />
      )}
    </div>
  );
}
