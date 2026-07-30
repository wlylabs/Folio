"use client";

import { useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";

export default function CreatePage() {
  const { address, isConnected } = useAccount();
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    symbol: "",
    supply: "1000000",
    startingPrice: "0.0002",
    articleTitle: "",
  });
  const [deploying, setDeploying] = useState(false);

  const editor = useEditor({
    extensions: [StarterKit],
    content: "<p>Tell the story behind your token...</p>",
  });

  const handleSubmit = async () => {
    if (!isConnected || !address) return;
    setDeploying(true);

    // TODO: deploy actual ERC20/sale contract here (e.g. via Thirdweb SDK)
    // For now this is a placeholder address — wire up real deployment before going live.
    const fakeContractAddress = "0x" + Math.random().toString(16).slice(2, 42).padEnd(40, "0");

    const { error } = await supabase.from("tokens").insert({
      contract_address: fakeContractAddress,
      chain: process.env.NEXT_PUBLIC_DEFAULT_CHAIN || "base-sepolia",
      name: form.name,
      symbol: form.symbol,
      supply: Number(form.supply),
      starting_price: Number(form.startingPrice),
      creator_wallet: address,
      article_title: form.articleTitle,
      article_body: editor?.getHTML() || "",
    });

    setDeploying(false);
    if (!error) router.push(`/token/${fakeContractAddress}`);
    else console.error(error);
  };

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "20px 20px 60px" }}>
      <h1 className="font-display" style={{ fontWeight: 900, fontSize: 28, marginBottom: 20 }}>
        Launch a Token
      </h1>

      {!isConnected && <ConnectButton />}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
        <input
          placeholder="Token name (e.g. Midnight Kettle)"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          style={inputStyle}
        />
        <input
          placeholder="Symbol (e.g. KETL)"
          value={form.symbol}
          onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })}
          style={inputStyle}
        />
        <input
          type="number"
          placeholder="Total supply"
          value={form.supply}
          onChange={(e) => setForm({ ...form, supply: e.target.value })}
          style={inputStyle}
        />
        <input
          type="number"
          step="0.0001"
          placeholder="Starting price (ETH)"
          value={form.startingPrice}
          onChange={(e) => setForm({ ...form, startingPrice: e.target.value })}
          style={inputStyle}
        />
        <input
          placeholder="Article headline"
          value={form.articleTitle}
          onChange={(e) => setForm({ ...form, articleTitle: e.target.value })}
          style={inputStyle}
        />

        <div style={{ border: "1px solid var(--rule)", padding: 12, minHeight: 160 }}>
          <EditorContent editor={editor} />
        </div>

        <button
          onClick={handleSubmit}
          disabled={!isConnected || deploying}
          className="font-ui"
          style={{
            padding: "14px 0",
            background: "var(--ink)",
            color: "var(--paper)",
            fontWeight: 600,
            letterSpacing: 1,
            border: "none",
            cursor: "pointer",
          }}
        >
          {deploying ? "Deploying..." : "Publish & Launch"}
        </button>
      </div>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "12px",
  border: "1px solid var(--rule)",
  fontFamily: "PT Serif, serif",
  fontSize: 14,
};
